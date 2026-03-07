import { useState, useEffect, useRef, useCallback } from "react";

// Drop this file into your Lab_Assistant React frontend
// Route: /scanner (or wherever you want it)
// Dep to add: npm install tesseract.js
// Usage: import LensScanner from './components/LensScanner';

export default function LensScanner() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const workerRef = useRef(null);

  const [phase, setPhase] = useState("init"); // init | loading | ready | scanning | found | error
  const [statusMsg, setStatusMsg] = useState("TAP START TO BEGIN");
  const [detectedJob, setDetectedJob] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [allText, setAllText] = useState("");
  const [log, setLog] = useState([]);
  const [scanLinePos, setScanLinePos] = useState(0);

  // Animate scan line
  useEffect(() => {
    if (phase !== "scanning") return;
    let pos = 0;
    let dir = 1;
    const interval = setInterval(() => {
      pos += dir * 2;
      if (pos >= 100) dir = -1;
      if (pos <= 0) dir = 1;
      setScanLinePos(pos);
    }, 16);
    return () => clearInterval(interval);
  }, [phase]);

  const startCamera = useCallback(async () => {
    setPhase("loading");
    setStatusMsg("REQUESTING CAMERA...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (e) {
      setPhase("error");
      setStatusMsg("CAMERA ERROR — ALLOW ACCESS IN BROWSER SETTINGS");
      return;
    }

    setStatusMsg("LOADING OCR ENGINE...");
    try {
      const { createWorker } = await import("tesseract.js");
      workerRef.current = await createWorker("eng", 1, {
        logger: (m) => {
          if (m.status === "loading tesseract core") setStatusMsg("LOADING ENGINE...");
          if (m.status === "initializing tesseract") setStatusMsg("INITIALIZING OCR...");
          if (m.status === "loading language traineddata") setStatusMsg("LOADING LANGUAGE...");
        },
      });
      await workerRef.current.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/",
        tessedit_pageseg_mode: "6",
      });
      setPhase("ready");
      setStatusMsg("READY — TAP SCAN");
    } catch (e) {
      setPhase("error");
      setStatusMsg("OCR LOAD FAILED: " + e.message);
    }
  }, []);

  const doScan = useCallback(async () => {
    if (phase !== "ready" && phase !== "found") return;
    if (!workerRef.current || !videoRef.current || !canvasRef.current) return;

    setPhase("scanning");
    setDetectedJob(null);
    setStatusMsg("SCANNING...");

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);

    // Contrast boost for engraved marks
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const boosted = Math.min(255, Math.max(0, (gray - 128) * 1.8 + 128));
      d[i] = d[i + 1] = d[i + 2] = boosted;
    }
    ctx.putImageData(imageData, 0, 0);

    try {
      const result = await workerRef.current.recognize(canvas);
      const rawText = result.data.text.trim();
      const conf = Math.round(result.data.confidence);

      const lines = rawText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length >= 3);

      const jobLine = lines.sort((a, b) => {
        const sA = (/\d/.test(a) ? 10 : 0) + a.length;
        const sB = (/\d/.test(b) ? 10 : 0) + b.length;
        return sB - sA;
      })[0];

      if (jobLine && conf > 20) {
        const job = jobLine.toUpperCase();
        setDetectedJob(job);
        setConfidence(conf);
        setAllText(rawText.replace(/\n/g, " ").substring(0, 80));
        setPhase("found");
        setStatusMsg(`DETECTED — ${conf}% CONFIDENCE`);
        setLog((prev) => [
          { job, conf, time: new Date().toTimeString().slice(0, 8), id: Date.now() },
          ...prev.slice(0, 9),
        ]);
        // TODO: POST to reunification API
      } else {
        setPhase("ready");
        setStatusMsg(
          conf < 20
            ? "LOW CONFIDENCE — CHECK LIGHTING & BACKGROUND"
            : "NO TEXT FOUND — ADJUST POSITION"
        );
      }
    } catch (e) {
      setPhase("ready");
      setStatusMsg("SCAN ERROR: " + e.message);
    }
  }, [phase]);

  // Spacebar shortcut
  useEffect(() => {
    const handler = (e) => {
      if (e.code === "Space" && (phase === "ready" || phase === "found")) {
        e.preventDefault();
        doScan();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase, doScan]);

  const copyToClipboard = (text, el) => {
    navigator.clipboard.writeText(text).then(() => {
      if (el) { el.textContent = "COPIED"; setTimeout(() => { el.textContent = "COPY"; }, 1500); }
    });
  };

  const dotColor =
    phase === "ready" ? "#00ff88" :
    phase === "scanning" ? "#00e5ff" :
    phase === "found" ? "#00ff88" :
    phase === "error" ? "#ff4455" :
    "#4a5568";

  const scanBtnLabel =
    phase === "init" ? "START CAMERA" :
    phase === "loading" ? "LOADING..." :
    phase === "scanning" ? "SCANNING..." :
    "SCAN";

  const scanBtnDisabled = phase === "loading" || phase === "scanning" || phase === "error";

  const handleMainBtn = () => {
    if (phase === "init") startCamera();
    else if (phase === "ready" || phase === "found") doScan();
  };

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <div style={styles.headerTitle}>LENS SCANNER</div>
          <div style={styles.headerSub}>JOB NUMBER DETECTION · PAIR EYEWEAR</div>
        </div>
        <div style={{ ...styles.dot, background: dotColor, boxShadow: phase === "ready" || phase === "found" ? `0 0 8px ${dotColor}` : "none" }} />
      </div>

      {/* Camera */}
      <div style={styles.cameraWrap}>
        <video ref={videoRef} style={styles.video} autoPlay playsInline muted />
        <canvas ref={canvasRef} style={{ display: "none" }} />

        {/* Brackets */}
        {(phase !== "init") && <>
          <div style={{ ...styles.bracket, top: "28%", left: "12%", borderWidth: "2px 0 0 2px" }} />
          <div style={{ ...styles.bracket, top: "28%", right: "12%", borderWidth: "2px 2px 0 0" }} />
          <div style={{ ...styles.bracket, bottom: "28%", left: "12%", borderWidth: "0 0 2px 2px" }} />
          <div style={{ ...styles.bracket, bottom: "28%", right: "12%", borderWidth: "0 2px 2px 0" }} />
        </>}

        {/* Scan line */}
        {phase === "scanning" && (
          <div style={{
            ...styles.scanLine,
            top: `${28 + (scanLinePos / 100) * 44}%`,
          }} />
        )}

        {/* Result overlay */}
        {phase === "found" && detectedJob && (
          <div style={styles.resultOverlay}>
            <div style={styles.resultLabel}>DETECTED JOB NUMBER</div>
            <div style={styles.resultNumber}>{detectedJob}</div>
            <div style={styles.resultConf}>
              {confidence}% CONFIDENCE
              {allText && <span style={{ color: "#2a3540" }}> · {allText}</span>}
            </div>
            <button
              style={styles.resultCopyBtn}
              onClick={(e) => copyToClipboard(detectedJob, e.currentTarget)}
            >
              COPY
            </button>
          </div>
        )}

        {/* Start screen */}
        {phase === "init" && (
          <div style={styles.startScreen}>
            <div style={{ fontSize: 56 }}>🔍</div>
            <div style={styles.startTitle}>LENS JOB SCANNER</div>
            <div style={styles.startDesc}>
              Point the camera at an etched lens on a dark background. Tap Scan to read the job number.
            </div>
            <div style={styles.startHint}>
              Use a dark cloth or black foam under the lens. Angle a light from the side for best results.
            </div>
          </div>
        )}

        {/* Error screen */}
        {phase === "error" && (
          <div style={styles.startScreen}>
            <div style={{ fontSize: 48 }}>📷</div>
            <div style={{ ...styles.startTitle, color: "#ff4455" }}>CAMERA ERROR</div>
            <div style={styles.startDesc}>{statusMsg}</div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <button
          style={{
            ...styles.scanBtn,
            ...(scanBtnDisabled ? styles.scanBtnDisabled : {}),
          }}
          onClick={handleMainBtn}
          disabled={scanBtnDisabled}
        >
          {scanBtnLabel}
        </button>

        {/* Log */}
        {log.length > 0 && (
          <div style={styles.logWrap}>
            {log.map((entry) => (
              <div key={entry.id} style={styles.logEntry}>
                <span style={styles.logNum}>{entry.job}</span>
                <span style={styles.logTime}>{entry.time} · {entry.conf}%</span>
                <button
                  style={styles.logCopy}
                  onClick={(e) => copyToClipboard(entry.job, e.currentTarget)}
                >
                  COPY
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={styles.statusBar}>{statusMsg}</div>
      </div>
    </div>
  );
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    background: "#080a0d",
    color: "#c8d4e0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif",
    overflow: "hidden",
    userSelect: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid #1c2330",
    background: "#0f1318",
    flexShrink: 0,
  },
  headerTitle: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 15,
    fontWeight: 600,
    color: "#00e5ff",
    letterSpacing: 0.5,
  },
  headerSub: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 11,
    color: "#4a5568",
    marginTop: 2,
  },
  dot: {
    width: 8, height: 8,
    borderRadius: "50%",
    transition: "background 0.3s",
  },
  cameraWrap: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    background: "#000",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  bracket: {
    position: "absolute",
    width: 48, height: 48,
    borderColor: "#00e5ff",
    borderStyle: "solid",
    opacity: 0.65,
    pointerEvents: "none",
  },
  scanLine: {
    position: "absolute",
    left: "12%", right: "12%",
    height: 1,
    background: "linear-gradient(90deg, transparent, #00e5ff, transparent)",
    pointerEvents: "none",
    transition: "top 0.016s linear",
  },
  resultOverlay: {
    position: "absolute",
    bottom: 0, left: 0, right: 0,
    background: "linear-gradient(transparent, rgba(0,0,0,0.9))",
    padding: "28px 20px 16px",
  },
  resultLabel: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 10,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: "#4a5568",
    marginBottom: 6,
  },
  resultNumber: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 38,
    fontWeight: 700,
    color: "#00ff88",
    letterSpacing: 3,
    lineHeight: 1.1,
  },
  resultConf: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 11,
    color: "#4a5568",
    marginTop: 5,
  },
  resultCopyBtn: {
    marginTop: 10,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 11,
    padding: "5px 16px",
    background: "rgba(0,255,136,0.1)",
    border: "1px solid rgba(0,255,136,0.3)",
    color: "#00ff88",
    cursor: "pointer",
    borderRadius: 3,
    letterSpacing: 1,
  },
  startScreen: {
    position: "absolute",
    inset: 0,
    background: "#080a0d",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
    zIndex: 10,
  },
  startTitle: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 18,
    fontWeight: 600,
    color: "#00e5ff",
    textAlign: "center",
  },
  startDesc: {
    fontSize: 14,
    color: "#4a5568",
    textAlign: "center",
    maxWidth: 300,
    lineHeight: 1.6,
  },
  startHint: {
    fontSize: 12,
    color: "#2a3540",
    textAlign: "center",
    maxWidth: 300,
    lineHeight: 1.6,
    marginTop: 4,
  },
  controls: {
    flexShrink: 0,
    background: "#0f1318",
    borderTop: "1px solid #1c2330",
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  scanBtn: {
    width: "100%",
    padding: 18,
    background: "#00e5ff",
    color: "#000",
    border: "none",
    fontSize: 15,
    fontWeight: 700,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    letterSpacing: 2,
    textTransform: "uppercase",
    cursor: "pointer",
    borderRadius: 4,
    WebkitAppearance: "none",
  },
  scanBtnDisabled: {
    background: "#1c2330",
    color: "#4a5568",
    cursor: "not-allowed",
  },
  logWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 120,
    overflowY: "auto",
  },
  logEntry: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    background: "#080a0d",
    border: "1px solid #1c2330",
    borderRadius: 3,
  },
  logNum: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 14,
    fontWeight: 600,
    color: "#00ff88",
    flex: 1,
  },
  logTime: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 10,
    color: "#4a5568",
  },
  logCopy: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 10,
    color: "#00e5ff",
    background: "none",
    border: "1px solid rgba(0,229,255,0.2)",
    padding: "2px 8px",
    cursor: "pointer",
    borderRadius: 2,
  },
  statusBar: {
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 11,
    color: "#4a5568",
    textAlign: "center",
  },
};
