# q-sys-mcp

[![CI](https://github.com/reowens/q-sys-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/reowens/q-sys-mcp/actions/workflows/ci.yml)

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent inspect and control a **Q-SYS** system over QSC's published **QRC** external-control protocol — pointed at a real Core *or* at Q-SYS Designer running in **Emulate mode**.

It's a wire-protocol client (like any Crestron/AMX integration), so it works on macOS, Windows, and Linux, and contains **zero QSC code**. This is an AI-native control layer QSC ships on no platform.

## What it does

Connects to a Q-SYS Core or emulator on TCP port **1710** (QRC, JSON-RPC 2.0) and exposes tools for:

- **Discovery** — list every named component, list a component's controls.
- **Read** — get Named Control values, get specific component control values, poll change groups for live meters/state.
- **Write** — set Named Controls and component controls, with optional ramp times.

> Writes mutate the running/emulated system. On an emulator nothing is saved unless you save the design in Designer.

## Requirements

- Node.js ≥ 18.
- A control target on port 1710:
  - **A real Q-SYS Core** with a design loaded and in **Run** mode, or
  - **Q-SYS Designer in Emulate mode** — open a design and press **F6** (or *File > Emulate*). Connect to `127.0.0.1:1710`.

Both QRC and ECP are fully functional in Emulate mode, so you can develop and test without any hardware.

## Install & run

```bash
npm install
npm run build
node dist/index.js     # MCP server on stdio
```

### MCP client config

```json
{
  "mcpServers": {
    "q-sys": {
      "command": "node",
      "args": ["/absolute/path/to/q-sys-mcp/dist/index.js"]
    }
  }
}
```

Then, from the agent: call `qsys_connect` (host `127.0.0.1`, port `1710` for a local emulator) before any other tool.

## Tools

| Tool | QRC method | Purpose |
|------|------------|---------|
| `qsys_connect` | (socket) + `Logon`/`StatusGet` | Connect to a Core/emulator |
| `qsys_status` | `StatusGet` | Engine status (platform, design, run state) |
| `qsys_list_components` | `Component.GetComponents` | List named components |
| `qsys_get_component_controls` | `Component.GetControls` | A component's controls + values |
| `qsys_get_control` | `Control.Get` | Get Named Control values |
| `qsys_get_component` | `Component.Get` | Get specific component control values |
| `qsys_set_control` | `Control.Set` | Set a Named Control (with optional ramp) |
| `qsys_set_component` | `Component.Set` | Set component controls (with optional ramps) |
| `qsys_create_change_group` | `ChangeGroup.AddControl` | Watch Named Controls for changes |
| `qsys_change_group_add_component` | `ChangeGroup.AddComponentControl` | Watch a component's controls |
| `qsys_poll_change_group` | `ChangeGroup.Poll` | Get changes since last poll |
| `qsys_destroy_change_group` | `ChangeGroup.Destroy` | Free a change group's server-side state |
| `qsys_disconnect` | (socket) | Close the connection |

`qsys_list_components` and `qsys_get_component_controls` accept optional `filter` (case-insensitive name substring), `names_only`, and — for components — `type`, to trim large designs before they reach the agent's context.

## Verify

```bash
npm test                               # offline: QRC integration + MCP-over-mock (no hardware)
npm run smoke -- 127.0.0.1 1710        # read-only smoke against a live emulator/Core
npm run smoke:mcp -- 127.0.0.1 1710    # full MCP-over-stdio smoke against a live target
npm run smoke:write -- 127.0.0.1 1710  # live WRITE round-trip: set a gain, verify, restore
npm run smoke:named -- MainGain        # live Named-Control read/set + change-group poll (pass your Named Control name)
npm run smoke:keepalive                # idle >60s, prove the socket survives QRC's idle close
```

`npm test` needs no hardware; every `smoke:*` script needs a live target (a real Core, or Designer in Emulate mode, on port 1710).

## CI

Linux, macOS, and Windows × Node 18 & 20 via GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): `npm ci && npm run build && npm run typecheck && npm test` on every push and PR. The whole suite is hardware-free (mock QRC server + in-memory MCP transport), so the full matrix runs without a Core.

## Roadmap / out of scope

- **WebSocket transport** via `@q-sys/qrwc` — convenience adapter for real Cores (raw QRC is the primary transport today).
- **Design authoring** (reading/writing `.qsys` files) — out of scope: `.qsys` is a compressed .NET `BinaryFormatter` graph type-coupled to QSC's assemblies.

## License

MIT. Q-SYS and QRC are trademarks/protocols of QSC, LLC; this project is an independent client and is not affiliated with or endorsed by QSC.
