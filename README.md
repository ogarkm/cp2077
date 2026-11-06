# 🌆 Cyberpunk 2077 — Web Experience

A browser-based Cyberpunk 2077 teaser and web runtime interface powered by WebGPU, multi-threaded WebAssembly, and high-performance video streaming.

---

## ⚡ Quick Start (Local Run)

You can launch the local server in any of the following ways (zero external dependencies required):

```bash
# Option 1: Direct shell script
./start.sh

# Option 2: Python 3
python3 serve.py

# Option 3: Auto-open browser on launch
python3 serve.py --open

# Option 4: npm (if you prefer Node workflows)
npm start
```

Once running, visit:
- **Teaser & Countdown:** [http://localhost:8080/](http://localhost:8080/)
- **Game Launcher:** [http://localhost:8080/game](http://localhost:8080/game)

---

## 🚀 How to Push to Git (Local / Remote)

This project is fully initialized as a Git repository.

### Push to GitHub / GitLab / Bitbucket
```bash
# 1. Add your remote repository URL:
git remote add origin https://github.com/YOUR_USERNAME/cyberpunk2077.git

# 2. Push to main:
git push -u origin main
```

### Push to a Local Bare Repository (if testing locally)
```bash
# Create a local bare repository:
git init --bare ~/cyberpunk2077-bare.git

# Add it as a local remote and push:
git remote add local ~/cyberpunk2077-bare.git
git push -u local main
```

---

## ☁️ Deploying to Render in the Future

The project includes pre-configured **Render Blueprint** (`render.yaml`) and zero-dependency Python configuration.

### Deploying via Render Blueprint (Recommended)
1. Push your repository to GitHub or GitLab.
2. Log into [Render Dashboard](https://dashboard.render.com).
3. Click **New +** → **Blueprint**.
4. Connect your `cyberpunk2077` repository.
5. Render will automatically detect `render.yaml` and set up the service:
   - **Runtime:** Python 3.11
   - **Start Command:** `python serve.py`
   - **Environment Variable:** `PORT` automatically handled.
6. Click **Apply**. Your app is live!

### Manual Web Service Configuration on Render
- **Environment:** `Python`
- **Build Command:** *(leave empty or `pip install -r requirements.txt`)*
- **Start Command:** `python serve.py`
- **Plan:** Free

---

## 🛠️ Features & QoL Improvements

1. **Mandatory WebGPU / WebAssembly Isolation Headers:**
   - Multi-threaded WebAssembly with `SharedArrayBuffer` requires Cross-Origin Isolation (`crossOriginIsolated = true`).
   - `serve.py` automatically injects:
     - `Cross-Origin-Opener-Policy: same-origin`
     - `Cross-Origin-Embedder-Policy: require-corp`
     - `Cross-Origin-Resource-Policy: cross-origin`
     - `Access-Control-Allow-Origin: *`

2. **HTTP 206 Partial Content (Range Requests):**
   - Built-in Range header support for seamless playback and looping of `bg-loop.mp4` on Safari, iOS, and Chrome without stutter or buffering traps.

3. **Dedicated Game Route:**
   - `/game` automatically routes to `game/index.html` with full loader integration, canvas mounting, and diagnostics.

4. **Upstream Reverse Proxy Fallback:**
   - Any runtime or probe calls not hosted locally are proxied automatically to `https://cyberpunk2077.lol`.

5. **Clean Git Architecture:**
   - Comprehensive `.gitignore` protecting against `.DS_Store`, build caches, and sensitive files.
