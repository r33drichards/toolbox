package mcp.filesystem

# Read-only access to the language assets (bootstrap.js); everything else
# is denied. This is how executions load the bootstrap without a sidecar
# HTTP server — `await fs.readFile('/opt/languages/bootstrap.js')`.
default allow = false

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
