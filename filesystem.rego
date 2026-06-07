package mcp.filesystem

# Read-only access to the language assets (bootstrap.js), plus a read+write
# scratch area under /work. Everything else is denied. The bootstrap is loaded
# without a sidecar HTTP server — `await fs.readFile('/opt/languages/bootstrap.js')`.
default allow = false

# Read + write scratch space under /work (all fs operations).
allow if {
    startswith(input.path, "/work")
}

allow if {
    input.operation == "readFile"
    startswith(input.path, "/opt/languages/")
}

allow if {
    input.operation == "exists"
    startswith(input.path, "/opt/languages/")
}

allow if {
    input.operation == "stat"
    startswith(input.path, "/opt/languages/")
}

allow if {
    input.operation == "readdir"
    startswith(input.path, "/opt/languages")
}
