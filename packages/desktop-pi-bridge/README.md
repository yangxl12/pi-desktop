# Pi Desktop Pi Bridge

The bridge keeps the desktop application independent from Pi internals. `RpcPiAgentPort` speaks strict LF-delimited JSONL to `pi --mode rpc`; `FakePiAgentPort` drives deterministic UI and application tests.
