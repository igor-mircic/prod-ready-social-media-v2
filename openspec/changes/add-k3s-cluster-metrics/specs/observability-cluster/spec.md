## ADDED Requirements

### Requirement: The obs prometheus chart values' comment block reflects slice-21 reality

The slice-17 prometheus chart values file at `infra/k8s-obs/base/prometheus/values.yaml` SHALL carry comments that accurately describe the chart's role in the data flow as of slice 21. Specifically:

- The bundled subcharts `alertmanager`, `prometheus-pushgateway`, `kube-state-metrics`, and `prometheus-node-exporter` SHALL remain disabled in the YAML keys (no runtime change), but the comment block SHALL name the slice-21 OTel-receiver-side path (`metrics-agent` DaemonSet + `metrics-cluster-agent` Deployment in the app cluster) as the replacement for the kube-state-metrics and prometheus-node-exporter subcharts.
- The default scrape jobs (`prometheus`, `kubernetes-api-servers`, `kubernetes-nodes`, `kubernetes-nodes-cadvisor`, `kubernetes-service-endpoints`, `kubernetes-service-endpoints-slow`, `prometheus-pushgateway`, `kubernetes-services`, `kubernetes-pods`, `kubernetes-pods-slow`) SHALL remain `enabled: false` in the YAML keys, and the comment block SHALL name remote-write (slice 18c) as the data-flow path that obviates them.
- The comment block SHALL NOT contain any forward-looking references to slice 21 as the home for scrape configs or for the kube-state-metrics / prometheus-node-exporter subcharts — those hints were misleading slice-17-era guesses and SHALL be retracted now that slice 21 has chosen the OTel-receiver-side path.

This is a narrative-only requirement: the chart's runtime configuration is unchanged. The intent is to keep the values.yaml's comments truthful for the next operator who reads it.

#### Scenario: Subchart keys stay disabled

- **WHEN** a reader inspects `infra/k8s-obs/base/prometheus/values.yaml`
- **THEN** `alertmanager.enabled`, `prometheus-pushgateway.enabled`, `kube-state-metrics.enabled`, and `prometheus-node-exporter.enabled` are all `false`

#### Scenario: Default scrape jobs stay disabled

- **WHEN** a reader inspects the `scrapeConfigs:` block
- **THEN** every default job key (the ten named above) has `enabled: false`

#### Scenario: Comment block no longer promises slice-21 scrape configs

- **WHEN** a reader greps the file for `slice 21` or `add-k3s-cluster-metrics`
- **THEN** any reference to slice 21 describes the OTel-receiver-side path (metrics-agent / metrics-cluster-agent agents shipping via remote-write), NOT a future chart-side scrape-job activation
- **AND** no comment claims that kube-state-metrics or prometheus-node-exporter subcharts will be enabled in slice 21

### Requirement: The obs grafana chart provisions the `cluster-overview` dashboard

The obs grafana chart (`infra/k8s-obs/base/grafana/`) SHALL provision a `cluster-overview.json` dashboard automatically alongside the existing slice-17 `custom-dashboard.json`. The provisioning mechanism SHALL be whichever shape the slice-17 chart already uses (a `dashboardProviders:` + `dashboards:` block in values.yaml, or a sibling ConfigMap mounted via `extraConfigmapMounts`) — slice 21 SHALL NOT introduce a competing provisioning mechanism alongside the existing one.

The dashboard JSON SHALL live at `infra/k8s-obs/base/grafana/dashboards/cluster-overview.json` (the directory created by this slice if not present). The slice-17 `custom-dashboard.json` SHALL remain unchanged.

#### Scenario: Dashboard JSON file lives at the documented path

- **WHEN** a reader runs `ls infra/k8s-obs/base/grafana/dashboards/cluster-overview.json`
- **THEN** the file exists and parses as valid JSON

#### Scenario: Provisioning reuses the slice-17 mechanism

- **WHEN** a reader compares the provisioning declaration for `cluster-overview.json` with the declaration for `custom-dashboard.json`
- **THEN** both dashboards are loaded via the same chart-level mechanism (no new helm chart, no new sidecar, no new ConfigMap pattern)

#### Scenario: Dashboard appears in obs grafana

- **WHEN** the obs cluster has applied the slice's manifests
- **AND** an operator opens obs grafana
- **AND** navigates to Dashboards → Browse
- **THEN** a dashboard titled `Cluster overview` is listed without any manual JSON import
