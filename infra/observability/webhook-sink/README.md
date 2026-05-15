# webhook-sink

Local-dev Alertmanager webhook sink. Started by the `observability`
docker-compose profile as `social-webhook-sink`, published on host port
`8081` (container `8080`).

Endpoints (all on `:8080` inside the container, `:8081` on the host):

- `POST /page` — Alertmanager `page-webhook` receiver target. Body is the
  standard Alertmanager webhook JSON envelope. Payload is appended to the
  in-memory ring, tagged with path `page` and the server-side receive
  timestamp (milliseconds since epoch).
- `POST /ticket` — same shape, tagged `ticket`.
- `GET /received` — returns the full ring as
  `{"received": [{"path", "receivedAt", "payload"}, ...]}`. Accepts
  `?after=<unix-millis>` to filter out entries received before the given
  timestamp (the e2e spec uses this to isolate its payloads from
  unrelated noise in a long-running stack).
- `GET /healthz` — returns `200 ok`. Used by the e2e spec's readiness
  probe in `beforeAll` to decide whether to skip the suite.

The ring holds the last `RING_CAPACITY` payloads (default 64, overridable
via env var). Restarting the container clears the ring — by design, this
sink is a local-dev surface, not a production receiver.

Rebuild after editing `server.js` or `package.json`:

```sh
docker-compose --profile observability build webhook-sink
docker-compose --profile observability up -d webhook-sink
```
