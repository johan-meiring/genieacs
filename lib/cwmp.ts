import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Socket } from "node:net";
import { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, Readable } from "node:stream";
import { promisify } from "node:util";
import { decode, encodingExists } from "iconv-lite";
import * as auth from "./auth.ts";
import * as config from "./config.ts";
import { generateDeviceId, once, setTimeoutPromise } from "./util.ts";
import * as soap from "./soap.ts";
import * as session from "./session.ts";
import {
  evaluateAsync,
  evaluate,
  extractParams,
} from "./common/expression/util.ts";
import * as cache from "./cache.ts";
import * as lock from "./lock.ts";
import * as localCache from "./cwmp/local-cache.ts";
import {
  clearTasks,
  deleteFault,
  deleteOperation,
  fetchDevice,
  getDueTasks,
  getFaults,
  getOperations,
  saveDevice,
  saveFault,
  saveOperation,
} from "./cwmp/db.ts";
import * as logger from "./logger.ts";
import * as scheduling from "./scheduling.ts";
import Path from "./common/path.ts";
import * as extensions from "./extensions.ts";
import {
  SessionContext,
  AcsRequest,
  SessionFault,
  Fault,
  Expression,
  SoapMessage,
  InformRequest,
  Preset,
  GetRPCMethodsResponse,
  CpeFault,
} from "./types.ts";
import { parseXmlDeclaration } from "./xml-parser.ts";
import * as debug from "./debug.ts";
import { getRequestOrigin } from "./forwarded.ts";
import { getSocketEndpoints } from "./server.ts";

const gzipPromisified = promisify(zlib.gzip);
const deflatePromisified = promisify(zlib.deflate);

const REALM = "GenieACS";
const MAX_CYCLES = 4;
const MAX_CONCURRENT_REQUESTS = +config.get("MAX_CONCURRENT_REQUESTS");

// Read the malformed-Inform recovery mode from Admin > Config, even when
// DeviceId is incomplete and no normal device session can be created.
// No configured value (or an invalid value) means disabled. The environment
// variable GENIEACS_INVALID_DEVICEID_RECOVERY is no longer consulted.
//
// With applyResetWindow, "reset" is limited to the daily windows in
// cwmp.invalidDeviceIdResetWindow (server local time, comma-separated
// "HH:MM-HH:MM" ranges, start inclusive, end exclusive; a range may cross
// midnight). Outside them, or if that setting is invalid, "log" is used and
// resetWindow reports the configured value. No window means reset at any time.
async function getInvalidDeviceIdRecoveryMode(
  applyResetWindow: boolean,
): Promise<{ mode: "disabled" | "log" | "reset"; resetWindow?: string }> {
  const snapshot = await localCache.getRevision();
  const now = Date.now();
  const configured = localCache.getConfig(
    snapshot,
    "cwmp.invalidDeviceIdRecovery",
    {},
    now,
  );
  if (configured == null || configured === "") return { mode: "disabled" };
  const mode = typeof configured === "string"
    ? configured.trim().toLowerCase()
    : "";
  if (mode !== "disabled" && mode !== "log" && mode !== "reset") {
    logger.warn({
      message: "Invalid cwmp.invalidDeviceIdRecovery setting; using disabled",
      valueType: typeof configured,
    });
    return { mode: "disabled" };
  }
  if (mode !== "reset" || !applyResetWindow) return { mode };

  const windowSetting = localCache.getConfig(
    snapshot,
    "cwmp.invalidDeviceIdResetWindow",
    {},
    now,
  );
  const resetWindow = typeof windowSetting === "string"
    ? windowSetting.trim()
    : windowSetting == null ? "" : String(windowSetting);
  if (!resetWindow) return { mode };

  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  let insideWindow = false;
  for (const range of resetWindow.split(",")) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(range);
    if (
      typeof windowSetting !== "string" ||
      !m || +m[1] > 23 || +m[2] > 59 || +m[3] > 23 || +m[4] > 59
    ) {
      logger.warn({
        message: "Invalid cwmp.invalidDeviceIdResetWindow setting; using log",
        valueType: typeof windowSetting,
      });
      return { mode: "log", resetWindow };
    }
    const start = +m[1] * 60 + +m[2];
    const end = +m[3] * 60 + +m[4];
    if (start <= end
      ? minute >= start && minute < end
      : minute >= start || minute < end) insideWindow = true;
  }
  return insideWindow ? { mode } : { mode: "log", resetWindow };
}

const INVALID_DEVICEID_PREFIX = "invalidid-";
const INVALID_DEVICEID_TTL_SECONDS = 120;

const MAX_SESSION_DURATION = 300000;
const LOCK_REFRESH_INTERVAL = 10000;
export const REQUEST_TIMEOUT = 10000;

const currentSessions = new WeakMap<Socket, SessionContext>();
const sessionsNonces = new WeakMap<Socket, string>();

const stats = {
  concurrentRequests: 0,
  totalRequests: 0,
  droppedRequests: 0,
  initiatedSessions: 0,
};

async function authenticate(
  sessionContext: SessionContext,
  body: string,
): Promise<boolean> {
  const authExpression: Expression = localCache.getConfigExpression(
    sessionContext.cacheSnapshot,
    "cwmp.auth",
  );
  if (authExpression == null) return true;

  let authentication;

  if (sessionContext.httpRequest.headers["authorization"]) {
    try {
      authentication = auth.parseAuthorizationHeader(
        sessionContext.httpRequest.headers["authorization"],
      );
    } catch (err) {
      return false;
    }
  }

  if (authentication?.method === "Digest") {
    const sessionNonce = sessionsNonces.get(sessionContext.httpRequest.socket);

    if (
      !sessionNonce ||
      authentication.nonce !== sessionNonce ||
      (authentication.qop && (!authentication.cnonce || !authentication.nc))
    )
      return false;

    authentication["body"] = body;
  }

  const res = await evaluateAsync(
    authExpression,
    {},
    sessionContext.timestamp,
    async (e: Expression): Promise<Expression> => {
      e = session.configContextCallback(sessionContext, e);
      if (Array.isArray(e) && e[0] === "FUNC") {
        if (e[1] === "EXT") {
          if (typeof e[2] !== "string" || typeof e[3] !== "string") return null;

          for (let i = 4; i < e.length; i++)
            if (Array.isArray(e[i])) return null;

          const { fault, value } = await extensions.run(e.slice(2));
          return fault ? null : value;
        } else if (e[1] === "AUTH") {
          const username = e[2];
          const password = e[3];
          if (username != null && password != null && authentication) {
            if (authentication["method"] === "Basic") {
              return (
                authentication["username"] === e[2] &&
                authentication["password"] === e[3]
              );
            }

            if (authentication["method"] === "Digest") {
              const expected = auth.digest(
                username,
                REALM,
                password,
                authentication["nonce"],
                "POST",
                authentication["uri"],
                authentication["qop"],
                authentication["body"],
                authentication["cnonce"],
                authentication["nc"],
              );
              return expected === authentication["response"];
            }
          }
          return false;
        }
      }
      return e;
    },
  );

  if (res && !Array.isArray(res)) return true;

  return false;
}

async function writeResponse(
  sessionContext: SessionContext,
  res,
  close = false,
): Promise<void> {
  // Close connection after last request in session
  if (close) res.headers["Connection"] = "close";

  let data = res.data;

  // Respond using the same content-encoding as the request
  if (
    sessionContext.httpRequest.headers["content-encoding"] &&
    res.data.length > 0
  ) {
    switch (sessionContext.httpRequest.headers["content-encoding"]) {
      case "gzip":
        res.headers["Content-Encoding"] = "gzip";
        data = await gzipPromisified(data);
        break;
      case "deflate":
        res.headers["Content-Encoding"] = "deflate";
        data = await deflatePromisified(data);
    }
  }

  const httpResponse = sessionContext.httpResponse;
  // Don't use httpResponse.socket as it may be null, even before end() is called
  const connection = sessionContext.httpRequest.socket;

  httpResponse.setHeader("Content-Length", Buffer.byteLength(data));
  httpResponse.writeHead(res.code, res.headers);
  if (sessionContext.debug)
    debug.outgoingHttpResponse(httpResponse, sessionContext.deviceId, res.data);
  httpResponse.end(data);

  if (connection.destroyed) {
    logger.accessError({
      sessionContext: sessionContext,
      message: "Connection dropped",
    });
    await endSession(sessionContext);
  } else if (close) {
    session.clearProvisions(sessionContext);
    await endSession(sessionContext);
  } else {
    const now = Date.now();
    sessionContext.lastActivity = now;
    currentSessions.set(connection, sessionContext);
    if (now >= sessionContext.extendLock) {
      sessionContext.extendLock = now + LOCK_REFRESH_INTERVAL;
      const lockToken = await lock.acquireLock(
        `cwmp_session_${sessionContext.deviceId}`,
        sessionContext.timeout * 1000 + LOCK_REFRESH_INTERVAL + REQUEST_TIMEOUT,
        0,
        `cwmp_session_${sessionContext.sessionId}`,
      );
      if (!lockToken) throw new Error("Failed to extend lock");
    }
  }
}

function recordFault(
  sessionContext: SessionContext,
  fault: Fault,
  provisions,
  channels,
): void;
function recordFault(sessionContext: SessionContext, fault: Fault): void;
function recordFault(
  sessionContext: SessionContext,
  fault: Fault,
  provisions?,
  channels?,
): void {
  if (!provisions) {
    provisions = sessionContext.provisions;
    channels = sessionContext.channels;
  }

  const channelKeys = Object.keys(channels);
  if (!channelKeys.length)
    throw new Error("Fault not associated with a channel!");

  const faults = sessionContext.faults;
  for (const channel of channelKeys) {
    const provs = sessionContext.faults[channel]
      ? sessionContext.faults[channel].provisions
      : [];
    faults[channel] = Object.assign(
      { provisions: provs, timestamp: sessionContext.timestamp },
      fault,
    ) as SessionFault;
    if (channel.startsWith("task_")) {
      const taskId = channel.slice(5);
      for (const t of sessionContext.tasks)
        if (t._id === taskId && t.expiry) faults[channel].expiry = t.expiry;
    }

    if (sessionContext.retries[channel] != null) {
      ++sessionContext.retries[channel];
    } else {
      sessionContext.retries[channel] = 0;
      if (channelKeys.length !== 1) faults[channel].retryNow = true;
    }

    if (channels[channel] === 0) faults[channel].precondition = true;

    if (!sessionContext.faultsTouched) sessionContext.faultsTouched = {};
    sessionContext.faultsTouched[channel] = true;

    logger.accessWarn({
      sessionContext: sessionContext,
      message: "Channel has faulted",
      fault: fault,
      channel: channel,
      retries: sessionContext.retries[channel],
    });
  }

  for (let i = 0; i < provisions.length; ++i) {
    for (const channel of channelKeys) {
      if ((channels[channel] >> i) & 1)
        faults[channel].provisions.push(provisions[i]);
    }
  }

  for (const channel of channelKeys) {
    const provs = faults[channel].provisions;
    faults[channel].provisions = [];
    appendProvisions(faults[channel].provisions, provs);
  }

  session.clearProvisions(sessionContext);
}

async function inform(
  sessionContext: SessionContext,
  rpc: SoapMessage,
): Promise<{ code: number; headers: Record<string, string>; data: string }> {
  const acsResponse = await session.inform(
    sessionContext,
    rpc.cpeRequest as InformRequest,
  );

  const res = soap.response({
    id: rpc.id,
    acsResponse: acsResponse,
    cwmpVersion: sessionContext.cwmpVersion,
  });

  const cookiesPath = localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.cookiesPath",
    {},
    sessionContext.timestamp,
    (e) => session.configContextCallback(sessionContext, e),
  );

  if (cookiesPath) {
    res.headers["Set-Cookie"] =
      `session=${sessionContext.sessionId}; Path=${cookiesPath}`;
  } else {
    res.headers["Set-Cookie"] = `session=${sessionContext.sessionId}`;
  }

  return res;
}

async function transferComplete(sessionContext, rpc): Promise<void> {
  const { acsResponse, operation, fault } = await session.transferComplete(
    sessionContext,
    rpc.cpeRequest,
  );

  if (!operation) {
    logger.accessWarn({
      sessionContext: sessionContext,
      message: "Unrecognized command key",
      rpc: rpc,
    });
  }

  if (fault) {
    Object.assign(sessionContext.retries, operation.retries);
    recordFault(
      sessionContext,
      fault,
      operation.provisions,
      operation.channels,
    );
  }

  const res = soap.response({
    id: rpc.id,
    acsResponse: acsResponse,
    cwmpVersion: sessionContext.cwmpVersion,
  });

  return writeResponse(sessionContext, res);
}

// Append provisions and remove duplicates
function appendProvisions(original, toAppend): boolean {
  let modified = false;
  const stringified = new WeakMap();

  for (const p of original) stringified.set(p, JSON.stringify(p));

  for (let i = toAppend.length - 1; i >= 0; --i) {
    let p = toAppend[i];
    const s = JSON.stringify(p);
    for (let j = original.length - 1; j >= 0; --j) {
      const ss = stringified.get(original[j]);
      if (s === ss) {
        if (!p || j >= original.length - (toAppend.length - i)) {
          p = null;
        } else {
          original.splice(j, 1);
          modified = true;
        }
      }
    }

    if (p) {
      original.splice(original.length - (toAppend.length - i) + 1, 0, p);
      stringified.set(p, s);
      modified = true;
    }
  }

  return modified;
}

const MAX_LOGGED_PATHS = 50;

// preset_loop diagnostics: close the current cycle's change sets (paths only,
// no values) and keep the last MAX_CYCLES + 1 cycles on the session.
function trackPresetCycleChanges(sessionContext: SessionContext): void {
  const { timestamps, attributes } = sessionContext.deviceData;
  if (timestamps.changes || attributes.changes) {
    const list = (s: Set<Path> | null): string[] =>
      s ? Array.from(s, (p) => p.toString()).sort() : [];
    if (!sessionContext.presetCycleChanges)
      sessionContext.presetCycleChanges = [];
    const history = sessionContext.presetCycleChanges;
    history.push({
      values: list(attributes.changes),
      refreshed: list(timestamps.changes),
    });
    if (history.length > MAX_CYCLES + 1) history.shift();
  }
  timestamps.changes = new Set();
  attributes.changes = new Set();
}

async function applyPresets(sessionContext: SessionContext): Promise<void> {
  const deviceData = sessionContext.deviceData;
  const presets = localCache.getPresets(sessionContext.cacheSnapshot);

  // Filter presets based on existing faults
  const blackList = {};
  let whiteList = null;
  let whiteListProvisions = null;
  const RETRY_DELAY = +localCache.getConfig(
    sessionContext.cacheSnapshot,
    "cwmp.retryDelay",
    {},
    sessionContext.timestamp,
    (e) => session.configContextCallback(sessionContext, e),
  );

  if (sessionContext.faults) {
    for (const [channel, fault] of Object.entries(sessionContext.faults)) {
      let retryTimestamp = 0;
      if (!fault.retryNow) {
        retryTimestamp =
          fault.timestamp +
          RETRY_DELAY * Math.pow(2, sessionContext.retries[channel]) * 1000;
      }

      if (retryTimestamp <= sessionContext.timestamp) {
        whiteList = channel;
        whiteListProvisions = fault.provisions;
        break;
      }

      blackList[channel] = fault.precondition ? 1 : 2;
    }
  }

  deviceData.timestamps.revision = 1;
  deviceData.attributes.revision = 1;

  const deviceEvents = {};
  for (const p of deviceData.paths.find(Path.parse("Events.*"), false, true)) {
    const attrs = deviceData.attributes.get(p);
    const t = attrs?.value[1][0] as number;
    if (t >= sessionContext.timestamp)
      deviceEvents[p.segments[1] as string] = true;
  }

  const parameters: { [name: string]: Path } = {};
  const filteredPresets: Preset[] = [];

  for (const preset of presets) {
    if (whiteList != null) {
      if (preset.channel !== whiteList) continue;
    } else if (blackList[preset.channel] === 1) {
      continue;
    }

    let eventsMatch = true;
    for (const [k, v] of Object.entries(preset.events)) {
      if (!v !== !deviceEvents[k.replace(/\s+/g, "_")]) {
        eventsMatch = false;
        break;
      }
    }

    if (!eventsMatch) continue;

    if (preset.schedule?.schedule) {
      const r = scheduling.cron(
        sessionContext.timestamp,
        preset.schedule.schedule,
      );
      if (!(r[0] + preset.schedule.duration > sessionContext.timestamp))
        continue;
    }

    filteredPresets.push(preset);
    for (const k of extractParams(
      evaluate(preset.precondition, null, sessionContext.timestamp),
    )) {
      // Mark channel in case of fault during fetching precondition
      sessionContext.channels[preset.channel] = 0;
      if (typeof k === "string") parameters[k] = Path.parse(k);
    }
    for (const prov of preset.provisions) {
      for (const arg of prov.slice(1)) {
        for (const k of extractParams(
          evaluate(arg, null, sessionContext.timestamp),
        )) {
          // Mark channel in case of fault during fetching precondition
          sessionContext.channels[preset.channel] = 0;
          if (typeof k === "string") parameters[k] = Path.parse(k);
        }
      }
    }
  }

  const declarations = Object.values(parameters).map((v) => ({
    path: v,
    pathGet: 1,
    pathSet: null,
    attrGet: { value: 1 },
    attrSet: null,
    defer: true,
  }));

  const {
    fault: flt,
    rpcId: reqId,
    rpc: acsReq,
  } = await session.rpcRequest(sessionContext, declarations);

  if (flt) {
    recordFault(sessionContext, flt);
    session.clearProvisions(sessionContext);
    return applyPresets(sessionContext);
  }

  if (acsReq) return sendAcsRequest(sessionContext, reqId, acsReq);

  session.clearProvisions(sessionContext);

  if (whiteList != null)
    session.addProvisions(sessionContext, whiteList, whiteListProvisions);

  const appendProvisionsToFaults = {};
  for (const p of filteredPresets) {
    if (
      evaluate(p.precondition, {}, sessionContext.timestamp, (e) =>
        session.configContextCallback(sessionContext, e),
      )
    ) {
      const provs = p.provisions.map((pp) => [
        pp[0],
        ...pp
          .slice(1)
          .map((arg) =>
            evaluate(arg, {}, sessionContext.timestamp, (e) =>
              session.configContextCallback(sessionContext, e),
            ),
          ),
      ]) as [string, ...Expression[]][];
      if (blackList[p.channel] === 2) {
        appendProvisionsToFaults[p.channel] = (
          appendProvisionsToFaults[p.channel] || []
        ).concat(provs);
      } else {
        session.addProvisions(sessionContext, p.channel, provs);
      }
    }
  }

  for (const [channel, provisions] of Object.entries(
    appendProvisionsToFaults,
  )) {
    if (
      appendProvisions(sessionContext.faults[channel].provisions, provisions)
    ) {
      if (!sessionContext.faultsTouched) sessionContext.faultsTouched = {};
      sessionContext.faultsTouched[channel] = true;
    }
  }

  // Don't increment when processing a single channel (e.g. after fault)
  if (whiteList == null)
    sessionContext.presetCycles = (sessionContext.presetCycles || 0) + 1;

  if (sessionContext.presetCycles > MAX_CYCLES) {
    trackPresetCycleChanges(sessionContext);
    const history = sessionContext.presetCycleChanges || [];
    history.forEach((c, i) => {
      logger.accessWarn({
        sessionContext: sessionContext,
        message: "Preset loop diagnostics",
        cycle: i + 1 - history.length, // 0 = last cycle before the fault
        channels: Object.keys(sessionContext.channels).join(","),
        changedValueCount: c.values.length,
        changedValues: c.values.slice(0, MAX_LOGGED_PATHS).join(","),
        refreshedCount: c.refreshed.length,
        refreshed: c.refreshed.slice(0, MAX_LOGGED_PATHS).join(","),
      });
    });

    const fault = {
      code: "preset_loop",
      message: "The presets are stuck in an endless configuration loop",
      timestamp: sessionContext.timestamp,
    };
    recordFault(sessionContext, fault);
    // No need to save retryNow
    for (const f of Object.values(sessionContext.faults)) delete f.retryNow;
    session.clearProvisions(sessionContext);
    return sendAcsRequest(sessionContext);
  }

  trackPresetCycleChanges(sessionContext);
  deviceData.timestamps.dirty = 0;
  deviceData.attributes.dirty = 0;
  const {
    fault: fault,
    rpcId: id,
    rpc: acsRequest,
  } = await session.rpcRequest(sessionContext, null);

  if (fault) {
    recordFault(sessionContext, fault);
    session.clearProvisions(sessionContext);
    return applyPresets(sessionContext);
  }

  if (!acsRequest) {
    for (const channel of Object.keys(sessionContext.channels)) {
      if (sessionContext.faults[channel]) {
        delete sessionContext.faults[channel];
        if (!sessionContext.faultsTouched) sessionContext.faultsTouched = {};
        sessionContext.faultsTouched[channel] = true;
      }
    }

    if (whiteList != null) return applyPresets(sessionContext);

    if (
      sessionContext.deviceData.timestamps.dirty > 1 ||
      sessionContext.deviceData.attributes.dirty > 1
    )
      return applyPresets(sessionContext);
  }

  return sendAcsRequest(sessionContext, id, acsRequest);
}

async function nextRpc(sessionContext: SessionContext): Promise<void> {
  const {
    fault: fault,
    rpcId: id,
    rpc: acsRequest,
  } = await session.rpcRequest(sessionContext, null);

  if (fault) {
    recordFault(sessionContext, fault);
    session.clearProvisions(sessionContext);
    return nextRpc(sessionContext);
  }

  if (acsRequest) return sendAcsRequest(sessionContext, id, acsRequest);

  for (const [channel, flags] of Object.entries(sessionContext.channels)) {
    if (flags && sessionContext.faults[channel]) {
      delete sessionContext.faults[channel];
      if (!sessionContext.faultsTouched) sessionContext.faultsTouched = {};

      sessionContext.faultsTouched[channel] = true;
    }
    if (channel.startsWith("task_")) {
      const taskId = channel.slice(5);
      if (!sessionContext.doneTasks) sessionContext.doneTasks = [];
      sessionContext.doneTasks.push(taskId);

      for (let j = 0; j < sessionContext.tasks.length; ++j) {
        if (sessionContext.tasks[j]._id === taskId) {
          sessionContext.tasks.splice(j, 1);
          break;
        }
      }
    }
  }

  session.clearProvisions(sessionContext);

  // Clear expired tasks
  sessionContext.tasks = sessionContext.tasks.filter((task) => {
    if (!(task.expiry <= sessionContext.timestamp)) return true;

    logger.accessInfo({
      sessionContext: sessionContext,
      message: "Task expired",
      task: task,
    });

    if (!sessionContext.doneTasks) sessionContext.doneTasks = [];
    sessionContext.doneTasks.push(task._id);

    const channel = `task_${task._id}`;
    if (sessionContext.faults[channel]) {
      delete sessionContext.faults[channel];
      if (!sessionContext.faultsTouched) sessionContext.faultsTouched = {};
      sessionContext.faultsTouched[channel] = true;
    }

    return false;
  });

  const task = sessionContext.tasks.find(
    (t) => !sessionContext.faults[`task_${t._id}`],
  );

  if (!task) return applyPresets(sessionContext);

  let alias;

  switch (task.name) {
    case "getParameterValues":
      // Set channel in case params array is empty
      sessionContext.channels[`task_${task._id}`] = 0;
      for (const p of task.parameterNames) {
        session.addProvisions(sessionContext, `task_${task._id}`, [
          ["refresh", p],
        ]);
      }

      break;
    case "setParameterValues":
      // Set channel in case params array is empty
      sessionContext.channels[`task_${task._id}`] = 0;
      for (const p of task.parameterValues) {
        session.addProvisions(sessionContext, `task_${task._id}`, [
          ["value", p[0], p[1]],
        ]);
      }

      break;
    case "refreshObject":
      session.addProvisions(sessionContext, `task_${task._id}`, [
        ["refresh", task.objectName],
      ]);
      break;
    case "reboot":
      session.addProvisions(sessionContext, `task_${task._id}`, [["reboot"]]);
      break;
    case "factoryReset":
      session.addProvisions(sessionContext, `task_${task._id}`, [["reset"]]);
      break;
    case "download":
      session.addProvisions(sessionContext, `task_${task._id}`, [
        ["download", task.fileType, task.fileName, task.targetFileName || ""],
      ]);
      break;
    case "addObject":
      alias = (task.parameterValues || [])
        .map((p) => `${p[0]}:${JSON.stringify(p[1])}`)
        .join(",");
      session.addProvisions(sessionContext, `task_${task._id}`, [
        ["instances", `${task.objectName}.[${alias}]`, "+1"],
      ]);
      break;
    case "deleteObject":
      session.addProvisions(sessionContext, `task_${task._id}`, [
        ["instances", task.objectName, 0],
      ]);
      break;
    case "provisions":
      session.addProvisions(
        sessionContext,
        `task_${task._id}`,
        task.provisions,
      );
      break;
    default:
      if (!sessionContext.doneTasks) sessionContext.doneTasks = [];
      sessionContext.doneTasks.push(task._id);
      sessionContext.tasks = sessionContext.tasks.filter((t) => t !== task);

      logger.accessWarn({
        sessionContext: sessionContext,
        message: "Invalid task",
        taskId: task._id,
      });
  }

  return nextRpc(sessionContext);
}

// Config snapshots are per worker and evicted 120 s after a config change.
// A session that outlives that, or moves to a worker that never loaded its
// snapshot, would otherwise crash the worker; continue with the current one.
async function ensureCacheSnapshot(
  sessionContext: SessionContext,
): Promise<void> {
  if (localCache.hasRevision(sessionContext.cacheSnapshot)) return;
  const previousRevision = sessionContext.cacheSnapshot;
  sessionContext.cacheSnapshot = await localCache.getRevision();
  logger.accessWarn({
    sessionContext: sessionContext,
    message: "Session config snapshot expired; using current revision",
    previousRevision: previousRevision,
    currentRevision: sessionContext.cacheSnapshot,
  });
}

async function endSession(sessionContext: SessionContext): Promise<void> {
  await ensureCacheSnapshot(sessionContext);
  if (sessionContext.provisions.length) {
    const fault = {
      code: "session_terminated",
      message: "The TR-069 session was unsuccessfully terminated",
      timestamp: sessionContext.timestamp,
    };
    recordFault(sessionContext, fault);
    // No need to save retryNow
    for (const f of Object.values(sessionContext.faults)) delete f.retryNow;
  }

  const promises = [];

  promises.push(
    saveDevice(
      sessionContext.deviceId,
      sessionContext.deviceData,
      sessionContext.new,
      sessionContext.timestamp,
    ),
  );

  if (sessionContext.operationsTouched) {
    for (const k of Object.keys(sessionContext.operationsTouched)) {
      if (sessionContext.operations[k]) {
        promises.push(
          saveOperation(
            sessionContext.deviceId,
            k,
            sessionContext.operations[k],
          ),
        );
      } else {
        promises.push(deleteOperation(sessionContext.deviceId, k));
      }
    }
  }

  if (sessionContext.doneTasks?.length) {
    promises.push(
      clearTasks(sessionContext.deviceId, sessionContext.doneTasks),
    );
  }

  if (sessionContext.faultsTouched) {
    for (const k of Object.keys(sessionContext.faultsTouched)) {
      if (sessionContext.faults[k]) {
        sessionContext.faults[k].retries = sessionContext.retries[k];
        promises.push(
          saveFault(sessionContext.deviceId, k, sessionContext.faults[k]),
        );
      } else {
        promises.push(deleteFault(sessionContext.deviceId, k));
      }
    }
  }

  await Promise.all(promises);
  await lock.releaseLock(
    `cwmp_session_${sessionContext.deviceId}`,
    `cwmp_session_${sessionContext.sessionId}`,
  );
  if (sessionContext.new) {
    logger.accessInfo({
      sessionContext: sessionContext,
      message: "New device registered",
    });
  }
}

async function sendAcsRequest(
  sessionContext: SessionContext,
  id?: string,
  acsRequest?: AcsRequest,
): Promise<void> {
  if (!acsRequest)
    return writeResponse(sessionContext, soap.response(null), true);

  if (acsRequest.name === "Download") {
    acsRequest.fileSize = 0;
    if (!acsRequest.url) {
      let prefix = "" + config.get("FS_URL_PREFIX");

      if (!prefix) {
        const FS_PORT = +config.get("FS_PORT");
        const ssl = !!config.get("FS_SSL_CERT");
        const origin = getRequestOrigin(sessionContext.httpRequest);
        let hostname = origin.localAddress;
        if (origin.host) [hostname] = origin.host.split(":", 1);
        prefix = (ssl ? "https" : "http") + `://${hostname}:${FS_PORT}/`;
      }

      acsRequest.url = prefix + encodeURI(acsRequest.fileName);

      const files = localCache.getFiles(sessionContext.cacheSnapshot);
      if (files[acsRequest.fileName])
        acsRequest.fileSize = files[acsRequest.fileName].length;
    }
  }

  const rpc = {
    id: id,
    acsRequest: acsRequest,
    cwmpVersion: sessionContext.cwmpVersion,
  };

  logger.accessInfo({
    sessionContext: sessionContext,
    message: "ACS request",
    rpc: rpc,
  });

  const res = soap.response(rpc);
  return writeResponse(sessionContext, res);
}

// When socket closes, store active sessions in cache
export async function onConnection(socket: Socket): Promise<void> {
  try {
    await once(socket, "close", MAX_SESSION_DURATION);
  } catch {
    socket.destroy();
  }

  const sessionContext = currentSessions.get(socket);
  if (!sessionContext) return;
  currentSessions.delete(socket);
  if (sessionContext.authState !== 2) {
    logger.accessError({
      message: "Authentication failure",
      sessionContext: sessionContext,
    });
    return;
  }

  const now = Date.now();

  const lastActivity = sessionContext.lastActivity;
  const timeoutMsg = {
    sessionContext: sessionContext,
    message: "Session timeout",
    sessionTimestamp: sessionContext.timestamp,
  };

  const timeout =
    sessionContext.lastActivity + sessionContext.timeout * 1000 - now;

  if (timeout <= 0) {
    logger.accessError(timeoutMsg);
    // TODO it's possible that lock would have already been expired
    await endSession(sessionContext);
    return;
  }

  await cache.set(
    `session_${sessionContext.sessionId}`,
    await session.serialize(sessionContext),
    Math.ceil(timeout / 1000) + 3,
  );

  await setTimeoutPromise(timeout + 1000, false);
  const sessionStr = await cache.get(`session_${sessionContext.sessionId}`);
  if (!sessionStr) return;

  const _sessionContext = await session.deserialize(sessionStr);
  if (_sessionContext.lastActivity === lastActivity) {
    logger.accessError(timeoutMsg);
    await endSession(sessionContext);
  }
}

export async function onClientError(err: Error, socket: Socket): Promise<void> {
  const remoteAddress = getSocketEndpoints(socket).remoteAddress;
  const cacheSnapshot = await localCache.getRevision();
  const debugEnabled = !!localCache.getConfig(
    cacheSnapshot,
    "cwmp.debug",
    {
      remoteAddress: remoteAddress,
    },
    Date.now(),
    (e) => {
      if (Array.isArray(e) && e[0] === "FUNC" && e[1] === "REMOTE_ADDRESS")
        return remoteAddress;
      return e;
    },
  );

  if (debugEnabled) debug.clientError(remoteAddress, err);
}

setInterval(() => {
  if (stats.droppedRequests) {
    logger.warn({
      message: "Worker overloaded",
      droppedRequests: stats.droppedRequests,
      totalRequests: stats.totalRequests,
      initiatedSessions: stats.initiatedSessions,
      pid: process.pid,
    });
  }

  stats.totalRequests = 0;
  stats.droppedRequests = 0;
  stats.initiatedSessions = 0;
}, 10000).unref();

async function reportBadState(sessionContext: SessionContext): Promise<void> {
  logger.accessError({
    message: "Bad session state",
    sessionContext: sessionContext,
  });
  const httpResponse = sessionContext.httpResponse;
  const body = "Bad session state";
  httpResponse.setHeader("Content-Length", Buffer.byteLength(body));
  httpResponse.writeHead(400, { Connection: "close" });
  if (sessionContext.debug)
    debug.outgoingHttpResponse(httpResponse, sessionContext.deviceId, body);
  httpResponse.end(body);
  if (sessionContext.state) return endSession(sessionContext);
}

async function responseUnauthorized(
  sessionContext: SessionContext,
  close: boolean,
): Promise<void> {
  const resHeaders = {};
  if (close) {
    // Invalid credentials
    logger.accessError({
      message: "Authentication failure",
      sessionContext: sessionContext,
    });

    resHeaders["Connection"] = "close";
  } else {
    if (getRequestOrigin(sessionContext.httpRequest).encrypted) {
      resHeaders["WWW-Authenticate"] = `Basic realm="${REALM}"`;
    } else {
      const nonce = crypto.randomBytes(16).toString("hex");
      sessionsNonces.set(sessionContext.httpRequest.socket, nonce);
      let d = `Digest realm="${REALM}"`;
      d += ',qop="auth,auth-int"';
      d += `,nonce="${nonce}"`;

      resHeaders["WWW-Authenticate"] = d;
    }
    currentSessions.set(sessionContext.httpRequest.socket, sessionContext);
  }

  const httpResponse = sessionContext.httpResponse;
  const body = "Unauthorized";
  httpResponse.setHeader("Content-Length", Buffer.byteLength(body));
  httpResponse.writeHead(401, resHeaders);
  if (sessionContext.debug)
    debug.outgoingHttpResponse(httpResponse, sessionContext.deviceId, body);
  httpResponse.end(body);
}

async function processRequest(
  sessionContext: SessionContext,
  rpc: SoapMessage,
  parseWarnings: Record<string, unknown>[],
  body: string,
): Promise<void> {
  await ensureCacheSnapshot(sessionContext);

  for (const w of parseWarnings) {
    w.sessionContext = sessionContext;
    logger.accessWarn(w);
  }

  if (sessionContext.state === 0) {
    if (rpc.cpeRequest?.name !== "Inform")
      return reportBadState(sessionContext);

    const res = await inform(sessionContext, rpc);

    sessionContext.debug = !!localCache.getConfig(
      sessionContext.cacheSnapshot,
      "cwmp.debug",
      {},
      sessionContext.timestamp,
      (e) => session.configContextCallback(sessionContext, e),
    );

    if (!sessionContext.timeout) {
      sessionContext.timeout = +localCache.getConfig(
        sessionContext.cacheSnapshot,
        "cwmp.sessionTimeout",
        {},
        sessionContext.timestamp,
        (e) => session.configContextCallback(sessionContext, e),
      );
    }

    sessionContext.httpRequest.socket.setTimeout(sessionContext.timeout * 1000);

    if (sessionContext.debug) {
      debug.incomingHttpRequest(
        sessionContext.httpRequest,
        sessionContext.deviceId,
        body,
      );
    }

    const authenticated = await authenticate(sessionContext, body);
    if (!authenticated) {
      if (!sessionContext.authState) {
        sessionContext.authState = 1;
        return responseUnauthorized(sessionContext, false);
      } else {
        return responseUnauthorized(sessionContext, true);
      }
    }

    sessionContext.extendLock =
      sessionContext.timestamp + LOCK_REFRESH_INTERVAL;
    const lockToken = await lock.acquireLock(
      `cwmp_session_${sessionContext.deviceId}`,
      sessionContext.timeout * 1000 + LOCK_REFRESH_INTERVAL + REQUEST_TIMEOUT,
      0,
      `cwmp_session_${sessionContext.sessionId}`,
    );

    if (!lockToken) {
      logger.accessError({
        message: "CPE already in session",
        sessionContext: sessionContext,
      });

      const _body = "CPE already in session";
      sessionContext.httpResponse.setHeader(
        "Content-Length",
        Buffer.byteLength(_body),
      );
      sessionContext.httpResponse.writeHead(400, { Connection: "close" });
      if (sessionContext.debug) {
        debug.outgoingHttpResponse(
          sessionContext.httpResponse,
          sessionContext.deviceId,
          _body,
        );
      }
      sessionContext.httpResponse.end(_body);
      return;
    }

    sessionContext.state = 1;
    sessionContext.authState = 2;

    logger.accessInfo({
      sessionContext: sessionContext,
      message: "Inform",
      rpc: rpc,
    });

    return writeResponse(sessionContext, res);
  }

  if (sessionContext.debug) {
    debug.incomingHttpRequest(
      sessionContext.httpRequest,
      sessionContext.deviceId,
      body,
    );
  }

  // Reauthenticate in case of new connection
  if (sessionContext.authState !== 2) {
    const authenticated = await authenticate(sessionContext, body);
    if (!authenticated) {
      if (!sessionContext.authState) {
        sessionContext.authState = 1;
        return responseUnauthorized(sessionContext, false);
      } else {
        await endSession(sessionContext);
        return responseUnauthorized(sessionContext, true);
      }
    }
    sessionContext.authState = 2;
  }

  if (rpc.cpeRequest) {
    if (rpc.cpeRequest.name === "TransferComplete") {
      if (sessionContext.state !== 1) return reportBadState(sessionContext);

      logger.accessInfo({
        sessionContext: sessionContext,
        message: "CPE request",
        rpc: rpc,
      });
      return transferComplete(sessionContext, rpc);
    } else if (rpc.cpeRequest.name === "GetRPCMethods") {
      if (sessionContext.state !== 1) return reportBadState(sessionContext);

      logger.accessInfo({
        sessionContext: sessionContext,
        message: "CPE request",
        rpc: rpc,
      });
      const res = soap.response({
        id: rpc.id,
        acsResponse: {
          name: "GetRPCMethodsResponse",
          methodList: ["Inform", "GetRPCMethods", "TransferComplete"],
        } as GetRPCMethodsResponse,
        cwmpVersion: sessionContext.cwmpVersion,
      });
      return writeResponse(sessionContext, res);
    } else {
      if (sessionContext.state !== 1 || rpc.cpeRequest.name === "Inform")
        return void reportBadState(sessionContext);

      throw new Error("ACS method not supported");
    }
  } else if (rpc.cpeResponse) {
    if (sessionContext.state !== 2) return reportBadState(sessionContext);

    const fault = await session.rpcResponse(
      sessionContext,
      rpc.id,
      rpc.cpeResponse,
    );
    if (fault) {
      recordFault(sessionContext, fault);
      session.clearProvisions(sessionContext);
    }
    return nextRpc(sessionContext);
  } else if (rpc.cpeFault) {
    if (sessionContext.state !== 2) return reportBadState(sessionContext);

    logger.accessWarn({
      sessionContext: sessionContext,
      message: "CPE fault",
      rpc: rpc,
    });

    const fault = await session.rpcFault(sessionContext, rpc.id, rpc.cpeFault);
    if (fault) {
      recordFault(sessionContext, fault);
      session.clearProvisions(sessionContext);
    }
    return nextRpc(sessionContext);
  } else if (rpc.unknownMethod) {
    if (sessionContext.state === 1) {
      logger.accessWarn({
        sessionContext: sessionContext,
        message: "Method not supported",
        method: rpc.unknownMethod,
      });

      const f: CpeFault = {
        faultCode: "Server",
        faultString: "CWMP fault",
        detail: {
          faultCode: "8000",
          faultString: "Method not supported",
        },
      };

      const res = soap.response({
        id: rpc.id,
        acsFault: f,
        cwmpVersion: sessionContext.cwmpVersion,
      });

      return writeResponse(sessionContext, res);
    } else if (sessionContext.state === 2) {
      const fault = {
        code: "invalid_response",
        message: "Response name does not match request name",
      };
      recordFault(sessionContext, fault);
      session.clearProvisions(sessionContext);
      return nextRpc(sessionContext);
    } else {
      return reportBadState(sessionContext);
    }
  } else {
    // CPE sent empty response
    if (sessionContext.state !== 1) return reportBadState(sessionContext);

    sessionContext.state = 2;
    const { faults, operations } =
      await session.timeoutOperations(sessionContext);

    for (const [i, f] of faults.entries()) {
      for (const [k, v] of Object.entries(operations[i].retries))
        sessionContext.retries[k] = v;

      recordFault(
        sessionContext,
        f,
        operations[i].provisions,
        operations[i].channels,
      );
    }

    return nextRpc(sessionContext);
  }
}

export async function listener(
  httpRequest: IncomingMessage,
  httpResponse: ServerResponse,
): Promise<void> {
  stats.concurrentRequests += 1;
  try {
    await listenerAsync(httpRequest, httpResponse);
  } catch (err) {
    currentSessions.delete(httpRequest.socket);
    throw err;
  } finally {
    stats.concurrentRequests -= 1;
  }
}

async function clientError(
  httpRequest: IncomingMessage,
  httpResponse: ServerResponse,
  sessionContext: SessionContext,
  body: string,
  msg: string,
): Promise<void> {
  let debugEnabled = false;
  let deviceId: string = null;

  if (sessionContext) {
    debugEnabled = sessionContext.debug;
    deviceId = sessionContext.deviceId;
  } else {
    const cacheSnapshot = await localCache.getRevision();
    debugEnabled = !!localCache.getConfig(
      cacheSnapshot,
      "cwmp.debug",
      {
        remoteAddress: getRequestOrigin(httpRequest).remoteAddress,
      },
      Date.now(),
      (e) => {
        if (Array.isArray(e) && e[0] === "FUNC" && e[1] === "REMOTE_ADDRESS")
          return getRequestOrigin(httpRequest).remoteAddress;
        return e;
      },
    );
  }

  httpResponse.setHeader("Content-Length", Buffer.byteLength(msg));
  httpResponse.writeHead(400, { Connection: "close" });

  if (debugEnabled) {
    debug.incomingHttpRequest(httpRequest, deviceId, body);
    debug.outgoingHttpResponse(httpResponse, deviceId, msg);
  }

  httpResponse.end(msg);
  if (sessionContext?.state) await endSession(sessionContext);
}

function decodeString(buffer: Buffer, charset: string): string {
  try {
    return buffer.toString(charset as BufferEncoding);
  } catch (err) {
    if (encodingExists(charset)) return decode(buffer, charset);
  }
  return null;
}

// Keep malformed-DeviceId recovery out of the regular GenieACS device/DB
// lifecycle. This cookie is opaque, one-time-use and valid across CWMP workers.
type InvalidDeviceIdRecoveryState = {
  stage: "inform" | "sent";
  remoteAddress: string;
  cwmpVersion: string;
  expiresAt: number;
  rpcId?: string;
};

function incompleteDeviceIdFields(deviceId: InformRequest["deviceId"]): string[] {
  const fields: (keyof InformRequest["deviceId"])[] = [
    "Manufacturer", "OUI", "ProductClass", "SerialNumber",
  ];
  return fields.filter(
    (field) => typeof deviceId?.[field] !== "string" ||
      !deviceId[field].trim(),
  );
}

function invalidDeviceIdLogFields(
  httpRequest: IncomingMessage,
  deviceId: InformRequest["deviceId"],
  missingFields: string[],
): Record<string, unknown> {
  // getRequestOrigin() respects GenieACS's trusted FORWARDED_HEADER setting.
  return {
    remoteAddress: getRequestOrigin(httpRequest).remoteAddress,
    peerAddress: httpRequest.socket.remoteAddress,
    missingFields: missingFields,
    manufacturer: deviceId.Manufacturer?.slice(0, 128),
    oui: deviceId.OUI?.slice(0, 128),
    productClass: deviceId.ProductClass?.slice(0, 128),
    serialNumber: deviceId.SerialNumber?.slice(0, 128),
  };
}

function sendInvalidDeviceIdSoap(
  httpResponse: ServerResponse,
  res: { code: number; headers: Record<string, string>; data: string },
): void {
  httpResponse.setHeader("Content-Length", Buffer.byteLength(res.data));
  httpResponse.writeHead(res.code, res.headers);
  httpResponse.end(res.data);
}

async function startInvalidDeviceIdRecovery(
  httpRequest: IncomingMessage,
  httpResponse: ServerResponse,
  rpc: SoapMessage,
  body: string,
  missingFields: string[],
): Promise<void> {
  const remoteAddress = getRequestOrigin(httpRequest).remoteAddress;
  const deviceId = (rpc.cpeRequest as InformRequest).deviceId;
  const fields = invalidDeviceIdLogFields(httpRequest, deviceId, missingFields);

  // Keep the existing cwmp.auth evaluation: reset must not bypass an ACS's
  // configured authentication policy. This temporary context is never saved.
  const token = crypto.randomBytes(16).toString("hex");
  const ctx = session.init(
    `invalid-deviceid-${token}`,
    rpc.cwmpVersion,
    rpc.sessionTimeout,
  );
  ctx.cacheSnapshot = await localCache.getRevision();
  ctx.httpRequest = httpRequest;
  ctx.httpResponse = httpResponse;
  await session.inform(ctx, rpc.cpeRequest as InformRequest);
  if (!(await authenticate(ctx, body))) {
    logger.accessWarn({
      message: "Invalid DeviceId recovery: authentication not satisfied",
      ...fields,
    });
    return responseUnauthorized(ctx, false);
  }

  const state: InvalidDeviceIdRecoveryState = {
    stage: "inform",
    remoteAddress: remoteAddress,
    cwmpVersion: rpc.cwmpVersion,
    expiresAt: Date.now() + INVALID_DEVICEID_TTL_SECONDS * 1000,
  };
  await cache.set(
    `invalid_deviceid_${token}`,
    JSON.stringify(state),
    INVALID_DEVICEID_TTL_SECONDS,
  );

  const res = soap.response({
    id: rpc.id,
    acsResponse: { name: "InformResponse" },
    cwmpVersion: rpc.cwmpVersion,
  });
  res.headers["Set-Cookie"] = `session=${INVALID_DEVICEID_PREFIX}${token}; Path=/; HttpOnly`;
  logger.accessWarn({
    message: "Invalid DeviceId recovery: Inform accepted for factory reset",
    ...fields,
  });
  return sendInvalidDeviceIdSoap(httpResponse, res);
}

async function continueInvalidDeviceIdRecovery(
  httpRequest: IncomingMessage,
  httpResponse: ServerResponse,
  sessionId: string,
  rpc: SoapMessage,
): Promise<void> {
  const token = sessionId.slice(INVALID_DEVICEID_PREFIX.length);
  if (!/^[0-9a-f]{32}$/.test(token)) {
    httpResponse.writeHead(400, { Connection: "close" });
    httpResponse.end("Invalid recovery session");
    return;
  }
  // pop() makes the continuation single-use even across workers.
  const saved = await cache.pop(`invalid_deviceid_${token}`);
  if (!saved) {
    httpResponse.writeHead(400, { Connection: "close" });
    httpResponse.end("Expired recovery session");
    return;
  }
  const state = JSON.parse(saved) as InvalidDeviceIdRecoveryState;
  const remoteAddress = getRequestOrigin(httpRequest).remoteAddress;
  if (state.remoteAddress !== remoteAddress || state.expiresAt < Date.now()) {
    logger.accessWarn({
      message: "Invalid DeviceId recovery: source changed or session expired",
      remoteAddress: remoteAddress,
      expectedRemoteAddress: state.remoteAddress,
    });
    httpResponse.writeHead(400, { Connection: "close" });
    httpResponse.end("Invalid recovery session");
    return;
  }

  if (state.stage === "inform") {
    // A CPE sends an empty POST after InformResponse when ready for an ACS RPC.
    if (rpc.cpeRequest || rpc.cpeResponse || rpc.cpeFault || rpc.unknownMethod) {
      httpResponse.writeHead(400, { Connection: "close" });
      httpResponse.end("Expected empty request before FactoryReset");
      return;
    }
    const rpcId = crypto.randomBytes(8).toString("hex");
    await cache.set(
      `invalid_deviceid_${token}`,
      JSON.stringify({ ...state, stage: "sent", rpcId }),
      INVALID_DEVICEID_TTL_SECONDS,
    );
    const res = soap.response({
      id: rpcId,
      cwmpVersion: state.cwmpVersion,
      acsRequest: { name: "FactoryReset" },
    });
    res.headers["Set-Cookie"] = `session=${sessionId}; Path=/; HttpOnly`;
    logger.accessWarn({
      message: "Invalid DeviceId recovery: FactoryReset sent",
      remoteAddress: remoteAddress,
    });
    return sendInvalidDeviceIdSoap(httpResponse, res);
  }

  if (state.stage === "sent") {
    if (rpc.id === state.rpcId && rpc.cpeResponse?.name === "FactoryResetResponse") {
      logger.accessWarn({
        message: "Invalid DeviceId recovery: FactoryResetResponse received",
        remoteAddress: remoteAddress,
      });
    } else {
      logger.accessWarn({
        message: "Invalid DeviceId recovery: unexpected response after FactoryReset",
        remoteAddress: remoteAddress,
        responseName: rpc.cpeResponse?.name || rpc.cpeFault?.detail?.faultCode ||
          rpc.unknownMethod || "empty",
      });
    }
    return sendInvalidDeviceIdSoap(httpResponse, soap.response(null));
  }
  httpResponse.writeHead(400, { Connection: "close" });
  httpResponse.end("Invalid recovery state");
}

async function listenerAsync(
  httpRequest: IncomingMessage,
  httpResponse: ServerResponse,
): Promise<void> {
  stats.totalRequests += 1;

  if (httpRequest.method !== "POST") {
    httpResponse.writeHead(405, {
      Allow: "POST",
      Connection: "close",
    });
    httpResponse.end("405 Method Not Allowed");
    return;
  }

  let sessionId;
  // Separation by comma is important as some devices don't comform to standard
  const COOKIE_REGEX =
    /\s*([a-zA-Z0-9\-_]+?)\s*=\s*"?([a-zA-Z0-9\-_]*?)"?\s*(,|;|$)/g;
  let match;
  while ((match = COOKIE_REGEX.exec(httpRequest.headers.cookie)))
    if (match[1] === "session") sessionId = match[2];

  // If overloaded, ask CPE to retry in 60 seconds
  if (!sessionId && stats.concurrentRequests > MAX_CONCURRENT_REQUESTS) {
    httpResponse.writeHead(503, {
      "Retry-after": 60,
      Connection: "close",
    });
    httpResponse.end("503 Service Unavailable");
    stats.droppedRequests += 1;
    return;
  }

  let stream: Readable = httpRequest;
  if (httpRequest.headers["content-encoding"]) {
    switch (httpRequest.headers["content-encoding"]) {
      case "gzip":
        stream = pipeline(stream, zlib.createGunzip(), () => {
          // Errors are also raised by the async iterator
        });
        break;
      case "deflate":
        stream = pipeline(stream, zlib.createInflate(), () => {
          // Errors are also raised by the async iterator
        });
        break;
      default:
        httpResponse.writeHead(415, { Connection: "close" });
        httpResponse.end("415 Unsupported Media Type");
        return;
    }
  }

  const chunks: Buffer[] = [];
  try {
    let readableEnded = false;
    stream.on("end", () => {
      readableEnded = true;
    });
    for await (const chunk of stream) chunks.push(chunk);
    // In Node versions prior to 15, the stream will not emit an error if the
    // connection is closed before the stream is finished.
    // For Node 12.9+ we can just use stream.readableEnded
    if (!readableEnded) throw new Error("Connection closed");
  } catch (err) {
    return;
  }

  const body = Buffer.concat(chunks);

  let sessionContext = currentSessions.get(httpRequest.socket);

  if (sessionContext) {
    currentSessions.delete(httpRequest.socket);
    sessionContext.httpRequest = httpRequest;
    sessionContext.httpResponse = httpResponse;
    if (
      (sessionContext.sessionId !== sessionId && sessionContext.state) ||
      sessionContext.lastActivity + sessionContext.timeout * 1000 < Date.now()
    ) {
      logger.accessError({
        message: "Invalid session",
        sessionContext: sessionContext,
      });

      return clientError(
        httpRequest,
        httpResponse,
        sessionContext,
        body.toString(),
        "Invalid session",
      );
    }
  }

  let charset: string;
  if (httpRequest.headers["content-type"]) {
    const m = httpRequest.headers["content-type"].match(
      /charset=['"]?([^'"\s]+)/i,
    );
    if (m) charset = m[1].toLowerCase();
  }

  if (!charset) {
    const parse = parseXmlDeclaration(body);
    const e = parse ? parse.find((s) => s.localName === "encoding") : null;
    charset = e ? e.value.toLowerCase() : "utf8";
  }

  const bodyStr = decodeString(body, charset);

  if (bodyStr == null) {
    if (!sessionContext && sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sessionContextString = await cache.pop(`session_${sessionId}`);
      if (sessionContextString) {
        sessionContext = await session.deserialize(sessionContextString);
        sessionContext.httpRequest = httpRequest;
        sessionContext.httpResponse = httpResponse;
      }
    }

    const msg = `Unknown encoding '${charset}'`;
    logger.accessError({
      message: "XML parse error",
      parseError: msg,
      sessionContext: sessionContext || {
        httpRequest: httpRequest,
        httpResponse: httpResponse,
      },
    });
    return clientError(
      httpRequest,
      httpResponse,
      sessionContext,
      body.toString(),
      msg,
    );
  }

  const parseWarnings = [];
  let rpc: SoapMessage;
  try {
    rpc = soap.request(bodyStr, parseWarnings);
  } catch (err) {
    if (!sessionContext && sessionId) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sessionContextString = await cache.pop(`session_${sessionId}`);
      if (sessionContextString) {
        sessionContext = await session.deserialize(sessionContextString);
        sessionContext.httpRequest = httpRequest;
        sessionContext.httpResponse = httpResponse;
      }
    }

    logger.accessError({
      message: "XML parse error",
      parseError: err.message,
      sessionContext: sessionContext || {
        httpRequest: httpRequest,
        httpResponse: httpResponse,
      },
    });

    return clientError(
      httpRequest,
      httpResponse,
      sessionContext,
      bodyStr,
      err.message,
    );
  }

  // Re-evaluate the GUI recovery mode at the start of each relevant request.
  // This works even if Manufacturer/OUI/ProductClass/SerialNumber are missing.
  // Only a new Inform is limited to the reset window; a recovery already in
  // progress may finish after the window closes.
  const invalidDeviceIdRecoveryState =
    sessionId?.startsWith(INVALID_DEVICEID_PREFIX) ||
    rpc.cpeRequest?.name === "Inform"
      ? await getInvalidDeviceIdRecoveryMode(
          !sessionId?.startsWith(INVALID_DEVICEID_PREFIX),
        )
      : { mode: "disabled" as const, resetWindow: undefined };
  const invalidDeviceIdRecovery = invalidDeviceIdRecoveryState.mode;

  // Intercept recovery sessions before the normal device-id/database flow.
  if (sessionId?.startsWith(INVALID_DEVICEID_PREFIX)) {
    if (invalidDeviceIdRecovery !== "reset") {
      httpResponse.writeHead(400, { Connection: "close" });
      httpResponse.end("DeviceId recovery disabled");
      return;
    }
    return continueInvalidDeviceIdRecovery(httpRequest, httpResponse, sessionId, rpc);
  }

  if (rpc.cpeRequest?.name === "Inform") {
    const informRequest = rpc.cpeRequest as InformRequest;
    const deviceIdInfo = informRequest.deviceId;
    const missingFields = incompleteDeviceIdFields(deviceIdInfo);
    if (missingFields.length && invalidDeviceIdRecovery !== "disabled") {
      logger.accessWarn({
        message: "CWMP Inform has incomplete DeviceId",
        recoveryMode: invalidDeviceIdRecovery,
        ...(invalidDeviceIdRecoveryState.resetWindow != null && {
          configuredMode: "reset",
          resetWindow: invalidDeviceIdRecoveryState.resetWindow,
        }),
        ...invalidDeviceIdLogFields(httpRequest, deviceIdInfo, missingFields),
      });
    }
    if (missingFields.length && invalidDeviceIdRecovery === "reset")
      return startInvalidDeviceIdRecovery(
        httpRequest, httpResponse, rpc, bodyStr, missingFields,
      );

    // Preserve unmodified GenieACS behaviour in disabled/log modes:
    // a missing OUI or serial number is rejected before session creation.
    if (!deviceIdInfo.OUI || !deviceIdInfo.SerialNumber) {
      const msg = "Missing or invalid DeviceId element";
      logger.accessError({
        message: "XML parse error",
        parseError: msg,
        sessionContext: sessionContext || {
          httpRequest: httpRequest,
          httpResponse: httpResponse,
        },
      });
      return clientError(
        httpRequest, httpResponse, sessionContext, bodyStr, msg,
      );
    }
  }
  if (!sessionContext && sessionId && rpc.cpeRequest?.name !== "Inform") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sessionContextString = await cache.pop(`session_${sessionId}`);
    if (sessionContextString) {
      sessionContext = await session.deserialize(sessionContextString);
      sessionContext.httpRequest = httpRequest;
      sessionContext.httpResponse = httpResponse;
      httpRequest.socket.setTimeout(sessionContext.timeout * 1000);
      if (sessionContext.authState !== 1) sessionContext.authState = 0;
    }
  }

  if (sessionContext)
    return processRequest(sessionContext, rpc, parseWarnings, bodyStr);

  if (rpc.cpeRequest?.name !== "Inform") {
    logger.accessError({
      message: "Invalid session",
      sessionContext: {
        httpRequest: httpRequest,
        httpResponse: httpResponse,
      },
    });

    return clientError(
      httpRequest,
      httpResponse,
      null,
      bodyStr,
      "Invalid session",
    );
  }

  if (stats.concurrentRequests > MAX_CONCURRENT_REQUESTS) {
    // Check again just in case device included old session ID
    // from the previous session
    httpResponse.writeHead(503, { "Retry-after": 60, Connection: "close" });
    httpResponse.end("503 Service Unavailable");
    stats.droppedRequests += 1;
    return;
  }

  stats.initiatedSessions += 1;
  const deviceId = generateDeviceId(rpc.cpeRequest.deviceId);

  const cacheSnapshot = await localCache.getRevision();

  const _sessionContext = session.init(
    deviceId,
    rpc.cwmpVersion,
    rpc.sessionTimeout,
  );

  _sessionContext.cacheSnapshot = cacheSnapshot;

  _sessionContext.httpRequest = httpRequest;
  _sessionContext.httpResponse = httpResponse;
  _sessionContext.sessionId = crypto.randomBytes(8).toString("hex");

  const [dueTasks, faults, operations] = await Promise.all([
    getDueTasks(deviceId, _sessionContext.timestamp),
    getFaults(deviceId),
    getOperations(deviceId),
  ]);

  _sessionContext.tasks = dueTasks[0];
  _sessionContext.operations = operations;
  _sessionContext.faults = faults;
  _sessionContext.retries = {};
  for (const [k, v] of Object.entries(_sessionContext.faults)) {
    if (v.expiry >= _sessionContext.timestamp) {
      // Delete expired faults
      delete _sessionContext.faults[k];
      if (!_sessionContext.faultsTouched) _sessionContext.faultsTouched = {};
      _sessionContext.faultsTouched[k] = true;
    } else {
      _sessionContext.retries[k] = v.retries;
    }
  }

  const parameters = await fetchDevice(
    _sessionContext.deviceId,
    _sessionContext.timestamp,
  );

  if (parameters) {
    for (const p of parameters) {
      const path = _sessionContext.deviceData.paths.add(p[0]);
      _sessionContext.deviceData.timestamps.set(path, p[1], 0);
      if (p[2]) _sessionContext.deviceData.attributes.set(path, p[2], 0);
    }
  } else {
    // Device not available in database, mark as new
    _sessionContext.new = true;
  }

  return processRequest(_sessionContext, rpc, parseWarnings, bodyStr);
}
