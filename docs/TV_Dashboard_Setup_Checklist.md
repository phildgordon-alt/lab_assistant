# TV Dashboard Setup Checklist

How to install and configure a wall-mounted TV running a Lab Assistant standalone dashboard. **Follow every step** — most "the dashboard looks weird" issues come from skipping one of these.

---

## 1. Hardware Requirements

- **Display**: 1080p minimum, 4K preferred. Any modern smart TV or monitor.
- **Browser**: One of these, in this order of preference:
  1. **Mac mini / Mac Studio** running Chrome or Safari in fullscreen — most reliable
  2. **Amazon Fire TV / Cube** with the Silk browser
  3. **Chromecast with Google TV** with the Chrome browser
  4. **Raspberry Pi 4** running Chromium in kiosk mode
- **Network**: Wired Ethernet preferred. WiFi works but adds latency.
- **Power**: TV and browser device on the same outlet that's NOT switched off at end of shift.

---

## 2. TV Picture Settings — CRITICAL

These settings are why the dashboards look cut off, stretched, or fuzzy. **Do this FIRST before anything else.**

Open the TV's Picture / Display menu and set:

| Setting | Required Value | Why |
|---|---|---|
| **Picture Size** / **Aspect Ratio** | **Native** (also called "Just Scan", "Dot by Dot", "Pixel Perfect", "Screen Fit") | TVs default to "Auto" or "16:9" which **crops 2-5% off all edges** (called "overscan") thinking it's broadcast TV. The dashboard edges literally cannot be seen until this is fixed. |
| **4:3 Stretch** | **OFF** | If on, will distort the dashboard horizontally. |
| **Picture Mode** | **Game Mode** or **Computer/PC Mode** | Disables motion smoothing and overscan. Critical. |
| **Sharpness** | **0 or 5** (low) | High sharpness on text causes ringing/halos. |
| **Motion Smoothing** / **TruMotion** / **MotionFlow** | **OFF** | Dashboards aren't motion content. |
| **Energy Saving** / **Eco Mode** | **OFF** | Dims the screen during low-motion content (which dashboards are). |
| **HDR** / **Dolby Vision** | **OFF** for dashboards | Causes the wrong color palette to render. |
| **Auto Brightness** | **OFF** | Lab fluorescent lighting confuses the sensor. Set manual brightness ~80%. |

**Verify by walking up to the TV and checking that you can see the leftmost and rightmost edges of the dashboard background.** If the SHIPPING DASHBOARD title at the top is cut off or the rightmost coater (EB9 #2) is missing, picture size is wrong.

---

## 3. Browser Settings

- **Fullscreen mode**: F11 on Chrome/Chromium, Cmd+Ctrl+F on Safari, or use the browser's kiosk mode flag.
- **Disable browser zoom**: Should be 100%. Cmd+0 to reset.
- **Disable scrollbars** (kiosk mode handles this).
- **Disable sleep/screensaver** on the device. macOS: Settings → Battery → Display sleep = Never.
- **Auto-launch on boot**: Configure the device to open the dashboard URL on power-on.

For Chrome kiosk mode (Mac mini / Pi):
```
chrome --kiosk --no-first-run --start-fullscreen --window-position=0,0 'http://192.168.0.224:3002/standalone/AssemblyDashboard.html'
```

For Safari (macOS): View → Enter Full Screen, or use a launchd plist that opens the URL on login.

---

## 4. Dashboard URL by Display Location

| Location | Display Type | URL |
|---|---|---|
| Assembly floor | 50"+ TV | `http://192.168.0.224:3002/standalone/AssemblyDashboard.html` |
| Coating zone | 50"+ TV | `http://192.168.0.224:3002/standalone/CoatingDashboard.html` |
| Cutting zone | 50"+ TV | `http://192.168.0.224:3002/standalone/CuttingDashboard.html` |
| Shipping zone | 50"+ TV | `http://192.168.0.224:3002/standalone/ShippingDashboard.html` |
| Above oven row | Widescreen TV | `http://192.168.0.224:3002/standalone/OvenTimer.html` |
| Per-coater wall tablet | 10" tablet | `http://192.168.0.224:3002/standalone/CoatingTimer.html` |

The dashboards self-refresh every 30-120 seconds. They also have a **6-hour forced page reload** built in (clears any browser memory drift on unattended displays). No human action needed once running.

---

## 5. Verification After Install

Walk up to the TV and confirm:
- ☐ Title bar is visible at the top (e.g., "SHIPPING DASHBOARD")
- ☐ Rightmost element fits inside the frame (no clipping)
- ☐ Bottom row of data is visible (not cut off)
- ☐ Server status dot is **green** (says "DVI LIVE" or similar)
- ☐ Time clock in header is updating
- ☐ KPI numbers are populated (not all 0 — except for Hero metrics that may be 0 early in shift)
- ☐ At normal lab walking distance (10-15 ft), the hero number is readable in <1 second

If anything fails the check:
1. First — re-verify Section 2 picture settings. **80% of issues are TV settings.**
2. Then check Server URL in Setup ⚙ — should be `http://192.168.0.224:3002`
3. Then check the Mac Studio is running: `curl http://192.168.0.224:3002/health` should return 200
4. Then call Phil

---

## 6. Common Symptoms → Causes

| Symptom | Likely Cause | Fix |
|---|---|---|
| Right or bottom of dashboard cut off | TV overscan | Picture Size = Native |
| Dashboard looks stretched / squished | 4:3 Stretch is ON | Turn 4:3 Stretch OFF |
| Text is fuzzy / has halos | Sharpness too high | Sharpness = 0–5 |
| Dashboard goes black periodically | Sleep / screensaver | Disable on the device |
| Numbers are old / not updating | Browser tab paused (TVs throttle background tabs) | Make sure dashboard is the foreground tab; the built-in 6h reload should self-recover |
| Server dot is red / "OFFLINE" | Network down or Lab Server down | Check `curl http://192.168.0.224:3002/health` from any machine |
| Data shows 0 across the board | Trace watcher down | DM `/lab coding restart the server` in Slack |

---

## 7. Samsung Galaxy Tablet Setup (CoatingTimer wall stations)

The per-coater timer runs on Samsung Galaxy tablets mounted to the wall at each coater. Galaxy tablets have specific quirks:

| Setting | Required Value | Why |
|---|---|---|
| **Browser** | Samsung Internet OR Chrome | NOT the default web view embedded in some apps — use the real browser |
| **Display Zoom** | 100% (Settings → Display → Screen zoom) | Galaxy defaults to a higher zoom that crops content |
| **Font Size** | Default (Settings → Display → Font size) | Larger fonts will overflow KPI tiles |
| **Auto-rotation** | OFF, locked to landscape | Wall-mounted tablets shouldn't flip |
| **Always On Display** | OFF | Drains battery, distracts |
| **Screen Timeout** | Never, or maximum (10+ min) plus tap occasionally | Settings → Display → Screen timeout |
| **Battery Optimization** | OFF for the browser app | Settings → Apps → Browser → Battery → Unrestricted |
| **Doze Mode** / **Adaptive Battery** | OFF for browser | Doze pauses background tabs and breaks polling |
| **Browser zoom** | Pinch to fit, then save as bookmark | Some tablets render at sub-1.0 zoom by default |

**Kiosk mode for Galaxy tablets:** Use the **Fully Kiosk Browser** app (free, well-supported). It auto-launches a URL on boot, prevents back button exit, hides the address bar, and disables sleep. Far more reliable than vanilla Chrome on Android.

**Mount orientation:** Landscape is preferred for CoatingTimer.html (better timer visibility). Confirm orientation lock matches.

**Per-tablet identity:** Each tablet needs to know which coater it belongs to. Open the dashboard, tap ⚙ Setup, set the Coater ID (e.g., "EB9 #1", "E1400"). This persists in localStorage so it survives reloads.

---

## 8. Maintenance

- Once a quarter: check picture settings haven't been reset by a firmware update.
- If a TV is replaced: redo Section 2 from scratch.
- The dashboards self-update via git pull on the Mac Studio — no per-TV updates required.
