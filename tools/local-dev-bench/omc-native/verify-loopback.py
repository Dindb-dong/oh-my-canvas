"""Verify the sandbox rejects non-loopback sockets and preserves workspace IPC."""

import errno
import json
import socket


with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
    server.settimeout(2)
    server.bind(("127.0.0.1", 0))
    server.listen()
    with socket.create_connection(server.getsockname(), timeout=2) as connection:
        connection.sendall(b"offline-ipc")
        peer, _ = server.accept()
        with peer:
            peer.settimeout(2)
            assert peer.recv(32) == b"offline-ipc"

# Numeric documentation-only addresses avoid invoking DNS from the sandbox.
denied = {}
for family, address in [(socket.AF_INET, "192.0.2.1"), (socket.AF_INET6, "2001:db8::1")]:
    with socket.socket(family, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        result = connection.connect_ex((address, 443))
        assert result in (errno.EPERM, errno.EACCES), f"Unexpected non-loopback connect result: {result}"
        denied[address] = errno.errorcode[result]
print(json.dumps({"loopback_ipc": "verified", "non_loopback_tcp": denied}, sort_keys=True))
