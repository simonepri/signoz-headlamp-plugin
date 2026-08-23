#!/bin/sh
# Stands up a kind cluster serving Headlamp with this plugin and a demo
# workload, then prints a login token and the port-forward command.
set -eu

example_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cluster=${KIND_CLUSTER:-plugin-demo}
namespace=headlamp-signoz

kind get clusters | grep -qx "$cluster" || kind create cluster --name "$cluster"
(cd "$example_dir/.." && pnpm install && pnpm build)
kubectl apply -f "$example_dir/workload.yaml"
kubectl get namespace "$namespace" >/dev/null 2>&1 || kubectl create namespace "$namespace"
kubectl -n "$namespace" create configmap signoz-headlamp-plugin \
  --from-file=main.js="$example_dir/../dist/main.js" \
  --from-file=package.json="$example_dir/../package.json" \
  --from-file=config.json="$example_dir/config.json" \
  --dry-run=client -o yaml | kubectl apply -f -
helm repo add headlamp https://kubernetes-sigs.github.io/headlamp/ >/dev/null 2>&1 || true
helm upgrade --install headlamp headlamp/headlamp \
  -n "$namespace" -f "$example_dir/headlamp-values.yaml"
kubectl -n "$namespace" rollout status "deploy/headlamp-signoz"

echo "Login token:"
kubectl -n "$namespace" create token "headlamp-signoz" --duration=4h
echo "Run: kubectl -n $namespace port-forward svc/headlamp-signoz 8466:80"
echo "Then open http://127.0.0.1:8466 and inspect a Deployment in the demo namespace."
