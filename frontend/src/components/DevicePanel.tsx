/** 正式模式：实时解码设备接入（LSL 设备 / 内置模拟设备）。 */
import { useEffect, useRef, useState } from "react";
import {
  Broadcast,
  Lightning,
  Plugs,
  PlugsConnected,
  StopCircle,
} from "@phosphor-icons/react";
import {
  liveEvents,
  liveStart,
  liveStatus,
  liveStop,
  lslStreams,
  type LslStreamInfo,
} from "../api/client";
import { useAppStore } from "../state/store";
import { BOOT_PARAMS } from "../App";
import { Button, Chip, Segmented } from "./ui";

export function DevicePanel() {
  const live = useAppStore((state) => state.live);
  const setLive = useAppStore((state) => state.setLive);
  const handleEvent = useAppStore((state) => state.handleEvent);
  const clearAll = useAppStore((state) => state.clearAll);

  const [device, setDevice] = useState<"mock" | "lsl">("mock");
  const [text, setText] = useState("HELLO WORLD");
  const [streams, setStreams] = useState<LslStreamInfo[]>([]);
  const [lslName, setLslName] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef(0);

  // 事件消费 + 状态轮询（运行中）
  useEffect(() => {
    if (!live.running) return undefined;
    let active = true;
    let eventTimer: number;
    let statusTimer: number;

    const syncStatus = async () => {
      try {
        const status = await liveStatus();
        if (!active) return;
        setLive({
          eventCount: status.event_count,
          decodedText: status.decoded_text,
          error: status.error,
        });
        if (status.error) setError(status.error);
      } catch {
        /* 忽略瞬时错误 */
      }
    };

    const pollEvents = async () => {
      try {
        const { events, next } = await liveEvents(cursorRef.current);
        cursorRef.current = next;
        for (const event of events) {
          handleEvent(event.code, {
            confidence: event.confidence ?? null,
            source: "live",
          });
        }
      } catch {
        /* 忽略瞬时错误 */
      }
      if (active) eventTimer = window.setTimeout(pollEvents, 250);
    };

    void syncStatus().then(() => {
      // 以当前事件数为起点，避免重放历史事件
      cursorRef.current = live.eventCount || 0;
    });
    void pollEvents();
    statusTimer = window.setInterval(syncStatus, 1500);
    return () => {
      active = false;
      window.clearTimeout(eventTimer);
      window.clearInterval(statusTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.running]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const config =
        device === "mock"
          ? { source: "mock" as const, text: text.trim() || "HELLO WORLD", interval: 0.9 }
          : { source: "lsl" as const, lsl_name: lslName || undefined };
      cursorRef.current = 0;
      let status;
      try {
        status = await liveStart(config);
      } catch (err) {
        // 上次会话遗留的流仍在运行：先停止再重连一次
        if (/已在运行|running/i.test((err as Error).message)) {
          await liveStop();
          status = await liveStart(config);
        } else {
          throw err;
        }
      }
      clearAll();
      setLive({ running: status.running, source: status.source, error: status.error, eventCount: 0, decodedText: "" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const status = await liveStop();
      setLive({ running: status.running, source: null, error: null });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scanStreams = async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await lslStreams();
      setStreams(result.streams);
      if (!result.streams.length) {
        setError("未发现 EEG 类型的 LSL 流，请确认设备已开始推流（或先安装 pylsl）");
      }
    } catch (err) {
      setError((err as Error).message);
      setStreams([]);
    } finally {
      setScanning(false);
    }
  };

  // 深链接自动连接：?mode=formal&live=HELLO WORLD
  useEffect(() => {
    const liveText = BOOT_PARAMS.get("live");
    if (liveText && !live.running) {
      const target = liveText === "1" ? "HELLO WORLD" : liveText;
      setText(target);
      setDevice("mock");
      void (async () => {
        try {
          let status;
          try {
            status = await liveStart({ source: "mock", text: target, interval: 0.9 });
          } catch (err) {
            if (/已在运行|running/i.test((err as Error).message)) {
              await liveStop();
              status = await liveStart({ source: "mock", text: target, interval: 0.9 });
            } else {
              throw err;
            }
          }
          cursorRef.current = 0;
          clearAll();
          setLive({ running: status.running, source: status.source, error: status.error, eventCount: 0, decodedText: "" });
        } catch (err) {
          setError((err as Error).message);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="device-widget widget-segment">
      <div className="device-head">
        <span className="widget-eyebrow">
          {live.running ? <PlugsConnected size={12} weight="fill" /> : <Plugs size={12} weight="fill" />}
          实时解码 · 设备接入
        </span>
        <div className="device-head-status">
          {live.running && (
            <Chip className="chip-live">
              <span className="live-dot" /> 解码中 · {live.eventCount} 事件 · {live.decodedText || "…"}
            </Chip>
          )}
        </div>
      </div>

      {!live.running ? (
        <div className="device-setup">
          <Segmented
            ariaLabel="设备类型"
            options={[
              { value: "mock", label: <><Lightning size={13} weight="duotone" /> 模拟设备</> },
              { value: "lsl", label: <><Broadcast size={13} weight="duotone" /> LSL 设备</> },
            ]}
            value={device}
            onChange={setDevice}
          />
          {device === "mock" ? (
            <div className="device-row">
              <input
                className="sim-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label="实时解码文本"
                placeholder="HELLO WORLD"
              />
              <Button variant="primary" onClick={() => void connect()} disabled={busy}>
                <PlugsConnected size={14} weight="fill" /> {busy ? "连接中…" : "连接并开始"}
              </Button>
            </div>
          ) : (
            <div className="device-row">
              <Button variant="default" onClick={() => void scanStreams()} disabled={scanning}>
                <Broadcast size={14} weight="duotone" /> {scanning ? "扫描中…" : "扫描设备流"}
              </Button>
              <select
                className="history-select"
                value={lslName}
                onChange={(event) => setLslName(event.target.value)}
                aria-label="选择 LSL 流"
              >
                <option value="">自动选择第一个 EEG 流</option>
                {streams.map((stream) => (
                  <option key={stream.uid || stream.name} value={stream.name}>
                    {stream.name}（{stream.channels} 通道 · {stream.sfreq} Hz）
                  </option>
                ))}
              </select>
              <Button variant="primary" onClick={() => void connect()} disabled={busy}>
                <PlugsConnected size={14} weight="fill" /> {busy ? "连接中…" : "连接并开始"}
              </Button>
            </div>
          )}
          {error && <div className="device-error">{error}</div>}
        </div>
      ) : (
        <div className="device-running">
          <Chip className="chip-device-active">
            <PlugsConnected size={13} weight="fill" /> 设备：{live.source === "lsl" ? "LSL 设备" : "模拟设备"}
          </Chip>
          {error && <Chip className="chip-reject">{error}</Chip>}
          <Button variant="danger" onClick={() => void disconnect()} disabled={busy}>
            <StopCircle size={14} weight="fill" /> 停止解码
          </Button>
        </div>
      )}
    </div>
  );
}
