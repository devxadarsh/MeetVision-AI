# MeetVision AI 🎙️👁️

> **On-Device Real-Time Meeting Copilot & Stealth Overlay Assistant**  
> Listens to your meetings (Zoom, Google Meet, Microsoft Teams), detects spoken questions, and provides live AI-generated talking points and answers on a floating, screen-share-protected HUD.

---

## 🌟 Key Features

- **🛡️ 100% Screen-Share Invisible:** Native OS capture exclusion (`setContentProtection(true)`) ensures the overlay and answers are visible only on your monitor—never to coworkers or clients on Zoom, Google Meet, or Microsoft Teams.
- **⚡ On-Device Neural Speech Recognition:** Powered by **NVIDIA Parakeet** (FastConformer & Nemotron models with Metal GPU acceleration) and **Apple Speech Engine** (Apple Silicon Neural Engine) for instantaneous, zero-latency transcription with zero audio uploaded to cloud servers.
- **💬 Real-Time In-Row Speech Dictation:** Speech streams smoothly into the active row with natural conversational pause handling (3-second inactivity auto-finalization) and no mid-sentence audio cuts.
- **🤖 Context-Aware AI Answers:** Triggers tailored talking points in real-time matching your exact role, domain glossary, and project context. Click **"⚡ Give Answer"** on any statement or question to synthesize talking points instantly.
- **🎨 Switchable HUD Interfaces:** 
  - **V1 Classic:** Sleek, minimalist floating overlay with hotkey badges.
  - **V2 Modern HUD:** Cyberpunk glassmorphic HUD with pulsing audio radar, glass cards, and status tags.
- **🌐 Multi-Workspace Persistence:** Stays pinned across all macOS Spaces and full-screen presentations (`visibleOnAllWorkspaces: true`).
- **📋 Post-Meeting Executive Summaries:** Generates structured meeting overviews, key questions, and action items with one-click Markdown file export.
- **🔒 Privacy First:** Ephemeral RAM-only audio processing; zero meeting recordings or transcripts written to disk unless explicitly enabled.

---

## 🏗️ System Architecture

- **Frontend:** Angular 22 (Standalone Components, Signals, Zoneless Change Detection, Tailwind CSS)
- **Backend / Desktop:** Electron (Hardened runtime, sandboxed preload, `contextIsolation: true`, secure IPC bridge)
- **Speech Engine:** NVIDIA Parakeet (`parakeet-cli` / Metal GPU) + Apple Speech Engine (ANE)
- **Packaging:** `electron-builder` (macOS DMG/ZIP for Apple Silicon `arm64` and Intel `x64`, Windows NSIS installer)

---

## 🚀 Getting Started (Development)

### Prerequisites
- **Node.js:** `v20.x` or `v22.x`
- **npm:** `v10.x` or `v11.x`
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Audio Routing (macOS):** Install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) or use built-in microphone.

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/MeetVision-AI.git
cd MeetVision-AI

# Install dependencies
npm install
```

### Running in Development Mode

```bash
# Start both Angular dev server (port 4200) and Electron with hot-reloading
npm run dev
```

Or start them individually:

```bash
# Terminal 1: Angular Vite dev server
npm run dev:ng

# Terminal 2: Compile Electron main process and launch Electron
npm run dev:electron
```

---

## 🛠️ Build Commands (Production & Multi-Platform)

MeetVision AI uses a two-stage build process:
1. **Angular Compilation:** Builds frontend hash-routed bundles into `dist/MeetVisionAI/browser/`.
2. **Electron Bundling:** Bundles `electron/main.ts` and sandboxed `electron/preload.ts` to `dist-electron/` using `esbuild`.
3. **Packaging (`electron-builder`):** Creates distributable installers.

### 1. Universal Clean Build (Compiles Angular + Electron)
Run this before packaging any platform:
```bash
npm run build
```

---

### 2. macOS Build Commands

#### A. Development / Unpackaged Local Build (macOS)
Creates an unpackaged directory build in `release/mac-arm64/` or `release/mac/` for instant local testing without creating DMGs:
```bash
# Build Angular & Electron, then package folder without signing
npm run package
```

#### B. Production DMG & ZIP (Apple Silicon - M1/M2/M3/M4)
```bash
# Build production bundle
npm run build

# Generate arm64 DMG and ZIP installers in release/
npx electron-builder --mac --arm64
```

#### C. Production DMG & ZIP (Intel x64)
```bash
# Build production bundle
npm run build

# Generate x64 DMG and ZIP installers in release/
npx electron-builder --mac --x64
```

#### D. Production Universal macOS Build (Both Arm64 + x64)
```bash
# Full build and automated packaging for all configured macOS architectures
npm run dist:mac
```

> **Output Location (macOS):** `release/MeetVision AI-<version>-arm64.dmg` and `release/MeetVision AI-<version>-mac.zip`.

---

### 3. Windows Build Commands

> **Note:** Windows installers can be built directly on Windows machines, or cross-compiled from macOS/Linux if Wine is installed. For CI/CD, building on a `windows-latest` GitHub Actions runner is recommended.

#### A. Development / Unpackaged Local Directory Build (Windows)
```bash
npm run build
npx electron-builder --win --dir
```

#### B. Production 64-bit NSIS Installer (Windows x64)
```bash
# Build production bundle
npm run build

# Generate Windows NSIS .exe installer in release/
npm run dist:win
```
Or with explicit target:
```bash
npx electron-builder --win nsis --x64
```

#### C. Windows 32-bit (ia32) or ARM64 (Optional)
```bash
npm run build
npx electron-builder --win nsis --ia32
```

> **Output Location (Windows):** `release/MeetVision AI Setup <version>.exe`.

---

## ⚙️ Environment Configurations

| Environment | Command | Angular Build Mode | Electron Dev Tools | Target URL |
| :--- | :--- | :--- | :--- | :--- |
| **Development** | `npm run dev` | JIT / Watch (`dev:ng`) | Enabled (Auto-opened) | `http://localhost:4200/#/<route>` |
| **Staging / Local Prod** | `npm run build && npx electron .` | AOT / Optimized (`build:ng`) | Disabled by default | `file://.../browser/index.html#/<route>` |
| **Production Dist** | `npm run dist:mac` / `npm run dist:win` | AOT Production Bundled | Disabled (`nodeIntegration: false`) | Self-contained signed installer |

---

## ⌨️ Global Keyboard Shortcuts

| Shortcut (macOS) | Shortcut (Windows) | Action |
| :--- | :--- | :--- |
| `CommandOrControl + Shift + H` | `Ctrl + Shift + H` | **Show / Hide Overlay** |
| `CommandOrControl + Shift + K` | `Ctrl + Shift + K` | **Clear Meeting Transcript** |
| `CommandOrControl + Shift + C` | `Ctrl + Shift + C` | **Copy Latest Answer** |
| `CommandOrControl + Shift + P` | `Ctrl + Shift + P` | **Pin / Unpin Active Question** |
| `CommandOrControl + Shift + X` | `Ctrl + Shift + X` | **Toggle Click-Through Mode** |
| `CommandOrControl + Shift + R` | `Ctrl + Shift + R` | **Regenerate Answer Talking Points** |
| `CommandOrControl + Escape` | `Ctrl + Escape` | **Emergency Panic Hide** |
| `Arrow Keys` (`↑ ↓ ← →`) | `Arrow Keys` | **Fine Window Repositioning** |

---

## 🔒 Security & Privacy Architecture

- **Strict Sandbox:** `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` are enforced across all three BrowserWindow instances (`Overlay`, `Settings`, `Capture`).
- **Encrypted Credentials:** LLM and cloud provider keys are encrypted using the native OS Keychain via Electron's `safeStorage` API.
- **Zero Remote Code:** Strict Content Security Policy (CSP) blocking remote `eval` and unverified scripts.
- **No Hidden Recording:** The on-screen recording and listening indicator cannot be disabled, ensuring complete compliance and transparency.

---

## 📄 License & Team

Built with ❤️ by the **MeetVision AI Team**. Distributed under the Proprietary / Commercial License.
