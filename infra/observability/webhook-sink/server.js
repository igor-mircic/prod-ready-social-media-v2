// Local-dev webhook sink for Alertmanager. Two POST endpoints (one per
// severity-routed receiver) append payloads to a bounded in-memory ring;
// `/received` exposes the ring as JSON, optionally filtered by receive
// timestamp. The e2e spec drives this surface directly via fetch().
//
// Not a production receiver — there is no auth, no persistence, no retry.
const express = require('express')

const PORT = Number(process.env.PORT ?? 8080)
const RING_CAPACITY = Number(process.env.RING_CAPACITY ?? 64)

const ring = []

function record(path, payload) {
  ring.push({ path, receivedAt: Date.now(), payload })
  while (ring.length > RING_CAPACITY) ring.shift()
}

const app = express()
app.use(express.json({ limit: '1mb' }))

app.post('/page', (req, res) => {
  record('page', req.body)
  res.status(200).send('ok')
})

app.post('/ticket', (req, res) => {
  record('ticket', req.body)
  res.status(200).send('ok')
})

app.get('/received', (req, res) => {
  const after = Number(req.query.after ?? 0)
  const filtered = Number.isFinite(after) && after > 0
    ? ring.filter((entry) => entry.receivedAt >= after)
    : ring.slice()
  res.status(200).json({ received: filtered })
})

app.get('/healthz', (_req, res) => {
  res.status(200).send('ok')
})

app.listen(PORT, () => {
  console.log(`webhook-sink listening on :${PORT} (ring capacity ${RING_CAPACITY})`)
})
