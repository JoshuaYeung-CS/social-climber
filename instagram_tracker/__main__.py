"""Run with: python -m instagram_tracker"""

import socket
import sys

import uvicorn

from .config import DEFAULT_HOST, DEFAULT_PORT


def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    print()
    print("=" * 60)
    print("  Instagram Tracker")
    print("=" * 60)
    print(f"  Mac:    http://localhost:{port}")
    ip = lan_ip()
    if ip:
        print(f"  Phone:  http://{ip}:{port}    (same Wi-Fi)")
    print("=" * 60)
    print("  Stop with Ctrl-C")
    print()

    uvicorn.run(
        "instagram_tracker.server:app",
        host=DEFAULT_HOST,
        port=port,
        log_level="info",
        reload=True,
        reload_dirs=["instagram_tracker"],
    )


if __name__ == "__main__":
    main()
