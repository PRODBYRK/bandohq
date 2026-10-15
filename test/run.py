#!/usr/bin/env python3
"""Kör BANDOHQ:s testsviter utan att något behöver installeras globalt.

    python3 test/run.py            # allt: databasen, edge-funktionerna, förhandsläget och molnet
    python3 test/run.py test       # bara test/test.html (förhandsläget)
    python3 test/run.py cloud      # bara test/cloud.html (startar emulatorn själv)
    python3 test/run.py db         # bara node-sviterna i db/test
    python3 test/run.py shot 'as=AZ&tab=team' bild.png [390] [1000] [3]   # skärmdump via test/shot.html (bredd, höjd, skala)
    # App Store 6,9": shot '…' bild.png 440 956 3 → 1320×2868

Webbläsartesterna körs i en egen headless Chrome (egen profil, hård tidsgräns). Sidan
skickar sitt resultat till /__result när den är klar, så ingen virtuell tid behövs —
den fryser klockan och appen räknar med riktiga timers.
"""
import http.server, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get('CHROME', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
RESULT = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_POST(self):
        if self.path != '/__result':
            self.send_error(404); return
        n = int(self.headers.get('Content-Length') or 0)
        RESULT['text'] = self.rfile.read(n).decode('utf-8', 'replace')
        self.send_response(204); self.end_headers()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def serve():
    port = free_port()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def chrome(args, timeout):
    prof = tempfile.mkdtemp(prefix='bandohq-chrome-')
    cmd = [CHROME, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
           '--disable-extensions', '--user-data-dir=' + prof] + args
    p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return p, prof


def stop(p, prof):
    try: os.killpg(p.pid, signal.SIGKILL)
    except Exception: pass
    p.wait()
    shutil.rmtree(prof, ignore_errors=True)


def page(name, timeout=900):
    srv, port = serve()
    RESULT.clear()
    p, prof = chrome(['--window-size=1440,1000', f'http://127.0.0.1:{port}/test/{name}'], timeout)
    t0 = time.time()
    try:
        while 'text' not in RESULT and time.time() - t0 < timeout and p.poll() is None:
            time.sleep(0.5)
    finally:
        stop(p, prof); srv.shutdown()
    text = RESULT.get('text')
    if text is None:
        print(f'✗ {name}: inget resultat inom {timeout} s'); return False
    fails = [l for l in text.splitlines() if l.startswith('FAIL') or 'KRASCH' in l]
    summary = [l for l in text.splitlines() if ' PASS · ' in l]
    for l in fails: print('  ' + l)
    print(f'{"✓" if not fails and summary else "✗"} {name}: {summary[-1] if summary else "ingen summering"}')
    return not fails and bool(summary)


def node(script):
    r = subprocess.run(['node', script], cwd=os.path.join(ROOT, 'db', 'test'), capture_output=True, text=True)
    out = r.stdout + r.stderr
    for l in out.splitlines():
        if l.startswith('FAIL') or 'Error' in l: print('  ' + l)
    summary = [l for l in out.splitlines() if ' PASS · ' in l]
    good = r.returncode == 0 and summary and ' 0 FAIL' in summary[-1]
    print(f'{"✓" if good else "✗"} db/test/{script}: {summary[-1] if summary else "kraschade"}')
    return bool(good)


def emulator():
    """Startar en färsk emulator på :8738 — molntestet räknar med en tom databas."""
    try: urllib.request.urlopen('http://127.0.0.1:8738/__outbox', timeout=1); print('✗ något kör redan på :8738 — stoppa det först'); return None
    except Exception: pass
    p = subprocess.Popen(['node', 'emulator.mjs'], cwd=os.path.join(ROOT, 'db', 'test'),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(120):
        time.sleep(0.5)
        try: urllib.request.urlopen('http://127.0.0.1:8738/__outbox', timeout=1); return p
        except Exception: pass
    os.killpg(p.pid, signal.SIGKILL); print('✗ emulatorn startade inte'); return None


def cloud():
    em = emulator()
    if not em: return False
    try: return page('cloud.html')
    finally:
        os.killpg(em.pid, signal.SIGKILL); em.wait()


def shot(params, out, width='390', height='1000', scale='1'):
    srv, port = serve()
    target = os.path.abspath(out)
    before = os.path.getmtime(target) if os.path.exists(target) else 0
    url = f'http://127.0.0.1:{port}/test/shot.html?{params}&w={width}&h={height}'
    p, prof = chrome(['--hide-scrollbars', '--force-prefers-reduced-motion', f'--window-size={max(int(width), 500)},{height}',
                      f'--force-device-scale-factor={scale}',
                      '--virtual-time-budget=6000', '--screenshot=' + target, url], 60)
    t0 = time.time()
    try:
        while time.time() - t0 < 60:
            if os.path.exists(target) and os.path.getmtime(target) > before: time.sleep(0.5); break
            time.sleep(0.3)
    finally:
        stop(p, prof); srv.shutdown()
    if not (os.path.exists(target) and os.path.getmtime(target) > before): print('✗ ingen bild'); return
    w, h = int(width) * int(scale), int(height) * int(scale)
    # fönstret är minst 500 px brett (headless) och ramen centrerad — skär ut telefonens yta ur mitten
    subprocess.run(['sips', '-c', str(h), str(w), target], capture_output=True)
    print(target)


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if what == 'shot':
        shot(sys.argv[2], sys.argv[3], *sys.argv[4:7]); sys.exit(0)
    ok = True
    if what in ('all', 'db'):
        ok &= node('db.test.mjs'); ok &= node('notify.test.mjs')
    if what in ('all', 'test'): ok &= page('test.html')
    if what in ('all', 'cloud'): ok &= cloud()
    print('✓ ALLT GRÖNT' if ok else '✗ NÅGOT ÄR RÖTT')
    sys.exit(0 if ok else 1)
