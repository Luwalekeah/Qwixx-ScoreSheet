# qwixx-scoresheet infra spec, luwah-k3s

Planning only. Nothing in this document has been applied. Verified against the local clone of `Luwalekeah/luwah-k3s` at `/Users/theafrooverlander/code/luwah-k3s` on 2026-09-01.

---

## OPEN QUESTIONS, resolve before the coder starts

**Q1. GHCR package visibility. Public or private?**
There is **zero** implemented precedent for `imagePullSecrets` in this repo. I grepped the whole tree. Not one manifest uses one. The only custom-image precedent is ko-pellet, which is a locally built image with `imagePullPolicy: Never` imported by hand into one node's containerd. GHCR plus an `imagePullSecret` is only a *documented recommendation*, in `docs/tech-stack-candidates.md` line 42:

> | 3. Registry | Push to **GHCR** (`ghcr.io/luwalekeah/<project>`) private images need an `imagePullSecret`; avoids the manual `k3s ctr images import` dance Ko-pellet requires |

Recommendation: make the GHCR package **public**. The image holds no secrets. All three runtime values arrive as env at pod start. A public package removes the first `imagePullSecret` on this cluster, removes a credential that expires, and removes a whole class of `ImagePullBackOff`. Section 1 gives both paths. Path B is marked and is skipped entirely if the answer is public.

**Q2. PostgREST does not expose the `qwixx` schema today. Approve the shared-component edit?**
This is the blocking finding of this spec. `namespaces/supabase/manifest.yaml` line 910:

```yaml
            - name: PGRST_DB_SCHEMAS
              value: public,storage,graphql_public
```

`qwixx` is not in that list. A `supabase-js` client calling `.schema('qwixx')` sends `Accept-Profile: qwixx` and PostgREST answers **406** for a profile it was not configured with. Every qwixx query fails, at runtime, after deploy, with a message that does not say "add the schema to an env var". Section 4 carries the consumer inventory and the one-line edit. Approve it, or the app cannot read its own tables.

**Q3. Public hostname.** Still undecided per `intent.md`. This spec uses the literal token `<<PUBLIC_HOSTNAME>>` in exactly one manifest location. Section 3 lists the three places it must be typed in total, two of which are outside Git.

**Q4. Health endpoint contract with the app agent.** The Deployment probes `GET /api/health` on port 3000. That route must return 200 with **no** database call, so a Supabase outage does not restart otherwise-healthy pods. If the app agent will not add it, say so now and the probes fall back to `GET /` which is heavier and couples readiness to render success.

---

## Corrections to the brief

Two premises in the task brief are wrong against the repo. Correcting them now so nothing gets designed around them.

| Brief said | Repo says | Consequence |
|---|---|---|
| "flannel does NOT enforce NetworkPolicy unless a policy engine is installed" | `docs/luwah-k3s-cluster/10-architecture/security.md` line 62: "k3s enforces NetworkPolicy through **kube-router**, so the capability exists, but no policies are written." Same statement repeats in `networking.md` line 63 and `hardening-tiers.md` line 29. | NetworkPolicy **is** enforceable here. A policy would not silently do nothing. See section 4.3 for why I still recommend shipping it inert. |
| "The ONLY genuinely public app is pwpush, exposed via a dedicated cloudflared Deployment" | Correct. Confirmed. | No change. |

Everything else in the brief checks out: k3s ApplicationSet include list, storage classes, no ingress controller, no cert-manager, Sealed Secrets controller name, Supabase already deployed on NodePort 30103 with Postgres 15.8.1.085.

---

## 1. Container image build and registry

### Current state

There is no registry on this cluster and no plan to run one. Two precedents exist and they disagree.

| Precedent | Where | Shape |
|---|---|---|
| ko-pellet | `namespaces/ko-pellet/manifest.yaml` | `image: ko-pellet:v1.1.0`, `imagePullPolicy: Never`, `nodeSelector: kubernetes.io/hostname: luwah-k3s-worker1`. Image lives only in that node's containerd. `renovate.json` line 70 disables Renovate for it. |
| Every third-party app | scriberr, homebox, librechat, immich, your-spotify | Pinned tag pulled from GHCR or Docker Hub. All public. No pull secret. |

ko-pellet is the anti-pattern. Its own manifest comment records the cost: "If worker1 is ever rebuilt, re-import ko-pellet:v1.1.0 there (or onto worker2) before moving this nodeSelector." That pins the pod to one node forever and makes a node rebuild an outage. Do not repeat it.

### Decision

Build in GitHub Actions in the app repo. Push to `ghcr.io/luwalekeah/qwixx-scoresheet`. Pin an immutable tag in the k3s manifest. No node pin, the pod floats across all three workers.

**The nodes are amd64 Dell OptiPlex machines. The MacBook is arm64.** Any local `docker build` produces an arm64 image that fails on the cluster with `exec format error`, which reads like a broken entrypoint and wastes an hour. GitHub Actions `ubuntu-latest` runners are amd64, so CI builds are correct by default. If anyone ever builds on the Mac, it must be `docker buildx build --platform linux/amd64`.

### Files to create in the app repo

`/Users/theafrooverlander/code/qwixx-scoresheet/Dockerfile`

Multi-stage, Next.js 15 standalone. Non-negotiables:

- `output: 'standalone'` must already be set in `next.config.ts`.
- Final stage runs as a numeric non-root uid. Use `1001`, matching the Next.js official standalone template's `nextjs` user, because the Deployment's `runAsUser` must match it exactly.
- Pin the base image by tag, never `latest`. Repo rule, `adding-and-deploying-apps.md` step 1.
- `EXPOSE 3000`, `ENV PORT=3000 HOSTNAME=0.0.0.0`. Without `HOSTNAME=0.0.0.0` the standalone server binds localhost only and every probe fails with connection refused while the pod looks alive.
- Do not bake any of the three secrets in at build time. They are runtime env only.

`/Users/theafrooverlander/code/qwixx-scoresheet/.github/workflows/image.yml`

- Trigger on `push: tags: ['v*']` only. Not on every commit to main. A tag is what pins the manifest.
- Permissions `contents: read`, `packages: write`.
- `docker/login-action` against `ghcr.io` with `${{ github.actor }}` and `${{ secrets.GITHUB_TOKEN }}`.
- `docker/build-push-action` with `platforms: linux/amd64` and `tags: ghcr.io/luwalekeah/qwixx-scoresheet:${{ github.ref_name }}`.
- Do not push a `latest` tag. It invites `imagePullPolicy: Always` drift.

### Path B, only if Q1 answers "private"

Add to `/Users/theafrooverlander/code/luwah-k3s/namespaces/qwixx/`:

- `ghcr-pull-sealed-secret.yaml`, SealedSecret named `ghcr-pull`, type `kubernetes.io/dockerconfigjson`, holding a GitHub classic PAT with `read:packages` only. Store the PAT in 1Password under *k3s - Qwixx*. Never in Git in plaintext.
- Add `imagePullSecrets: [{name: ghcr-pull}]` to the Deployment pod spec.

Sealing a dockerconfigjson secret needs the docker-registry secret form, not `--from-literal`:

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
PATH="/opt/homebrew/bin:$PATH" kubectl create secret docker-registry ghcr-pull -n qwixx \
  --docker-server=ghcr.io --docker-username=Luwalekeah --docker-password="$GHCR_PAT" \
  --dry-run=client -o yaml | \
kubeseal --controller-name=sealed-secrets-controller --controller-namespace=kube-system \
  --format=yaml > namespaces/qwixx/ghcr-pull-sealed-secret.yaml
```

This would be the first `imagePullSecret` on the cluster. It is also a credential that expires and takes the app down with `ImagePullBackOff` when it does. That is the argument for Q1 answering public.

### Renovate

`/Users/theafrooverlander/code/luwah-k3s/renovate.json`. Add a `packageRules` entry after the existing ko-pellet block at lines 69 to 75:

```json
    {
      "description": "qwixx-scoresheet is our own image. Version bumps come from tagging a release in the app repo, not from Renovate discovering a tag. Nothing for it to do here.",
      "matchPackageNames": [
        "ghcr.io/luwalekeah/qwixx-scoresheet"
      ],
      "enabled": false
    }
```

Without this, Renovate opens a PR every month bumping our own image to whatever tag we pushed last, and `"automerge": true` at line 16 merges it unreviewed.

---

## 2. The qwixx namespace manifests

All paths under `/Users/theafrooverlander/code/luwah-k3s/`.

| File | Holds | New or edit |
|---|---|---|
| `namespaces/qwixx/manifest.yaml` | Service (NodePort) plus Deployment | new |
| `namespaces/qwixx/sealed-secret.yaml` | SealedSecret `qwixx-secrets` | new |
| `namespaces/qwixx/cloudflared.yaml` | cloudflared connector Deployment | new |
| `namespaces/qwixx/cloudflared-sealed-secret.yaml` | SealedSecret `cloudflared-qwixx` | new |
| `namespaces/qwixx/cleanup-cronjob.yaml` | abandoned-game cleanup CronJob | new, see section 5 |
| `cluster/argocd/applicationset-luwah-k3s.yaml` | include-list entry | edit, section 6 |
| `namespaces/supabase/manifest.yaml` | `PGRST_DB_SCHEMAS` | edit, section 4 |
| `renovate.json` | disable rule | edit, section 1 |

**No `kind: Namespace` object goes in any file.** I verified this: zero matches for `kind: Namespace` across the whole `namespaces/` tree, and the ApplicationSet template sets `CreateNamespace=false` at line 63. `adding-and-deploying-apps.md` step 1 claims `manifest.yaml` holds "the Namespace". The doc is wrong and no app follows it. The namespace is created by hand, once, in step 3 of the rollout.

### Storage, explicitly

**qwixx has no PVC and needs none.** Client state lives in IndexedDB on the phone. Server state lives in the existing supabase Postgres. So the local-path versus NFS decision does not arise for this app.

Two guardrails that follow from that:

- Do not add a PVC for `.next/cache`. Standalone output ships its build cache in the image. A cache PVC would be the only stateful thing here and would pin the pod to a node for no benefit.
- The database this app writes to is `supabase-db`, whose PVC `supabase-db-data` is already `local-path` with a `nodeSelector` pinning it to `luwah-k3s-worker1` (`namespaces/supabase/manifest.yaml` lines 41 to 49 and 624 to 626). **Nothing in this spec moves it and nothing may.** The database-PVCs-stay-on-local-path rule is already satisfied and must remain satisfied.

### NodePort

NodePorts currently pinned in Git: 30080 to 30089, 30092 to 30095, 30097 to 30101, 30102 (Argo CD, `cluster/argocd/argocd-server-nodeport.yaml`), 30103 to 30110. Free in band: 30090, 30091, 30096, and 30111 upward. Highest in use is 30110 (pwpush).

**Use 30111.** Verify live before writing it, per `adding-and-deploying-apps.md` step 4:

```
[MacBook] export KUBECONFIG=~/.kube/luwah-tailscale.yaml && \
kubectl get svc -A -o jsonpath='{range .items[*]}{.spec.ports[*].nodePort}{"\n"}{end}' | sort -n | uniq
```

If Tailscale is down this hangs. Check `tailscale status` first. `~/.kube/luwah-lan.yaml` does not work from the MacBook, UFW on the master only permits 6443 on the Tailscale interface.

The NodePort is the fire escape, exactly as it is for pwpush. It is on the private LAN and Tailscale only. It is not the public path. The public path is the tunnel.

### `namespaces/qwixx/manifest.yaml`

```yaml
---
# Qwixx score sheet. Next.js 15 App Router, standalone output, listening on 3000.
#
# Public at https://<<PUBLIC_HOSTNAME>> through the dedicated Cloudflare Tunnel in
# cloudflared.yaml. That is the second genuinely public host on this cluster after
# pwpush, and it follows the same pattern. NodePort 30111 is the fire escape on
# LAN and Tailscale only, per house convention.
#
# Stateless by design. No PVC. Player state is IndexedDB on the phone, game state
# is the qwixx schema in the existing supabase Postgres. Do not add a volume here.
#
# Talks to Supabase server side only, over cluster DNS, with the service role key.
# The browser never sees a Supabase key and never reaches Kong. See section 4 of
# .pipeline/infra-spec.md in the app repo.
---
# === Service ===
# nodePort pinned. No NPM proxy host: this app is reached publicly through the
# tunnel, so a lan-only luwahdc hostname would add nothing.
apiVersion: v1
kind: Service
metadata:
  name: qwixx
  namespace: qwixx
spec:
  type: NodePort
  selector:
    app: qwixx
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
      nodePort: 30111
---
# === Deployment ===
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qwixx
  namespace: qwixx
spec:
  # replicas: 1 on purpose. intent.md requires the join endpoint to be rate
  # limited, and an in-process limiter does not share counters across pods.
  # Raising this silently multiplies the join rate limit by the replica count.
  # If a second replica is ever wanted, move the limiter to a Postgres table first.
  replicas: 1
  selector:
    matchLabels:
      app: qwixx
  template:
    metadata:
      labels:
        app: qwixx
    spec:
      automountServiceAccountToken: false      # never calls the k8s API
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001                        # must match the Dockerfile's nextjs uid
        runAsGroup: 1001
        fsGroup: 1001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: qwixx
          image: ghcr.io/luwalekeah/qwixx-scoresheet:v0.1.0   # pin the tag CI actually pushed
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          env:
            # -- Cluster-internal Kong. Read from namespaces/supabase/manifest.yaml
            # -- (Service supabase-kong, namespace supabase, port 8000). Not a
            # -- secret, so it is a plain value. NEVER the NodePort form
            # -- http://192.168.10.20:30103, which would route app traffic out
            # -- to the node IP and back for no reason.
            - name: SUPABASE_URL
              value: "http://supabase-kong.supabase.svc.cluster.local:8000"
            - name: SUPABASE_SERVICE_ROLE_KEY
              valueFrom:
                secretKeyRef:
                  name: qwixx-secrets
                  key: SUPABASE_SERVICE_ROLE_KEY
            - name: QWIXX_COOKIE_SECRET
              valueFrom:
                secretKeyRef:
                  name: qwixx-secrets
                  key: QWIXX_COOKIE_SECRET
            - name: QWIXX_IP_HASH_SECRET
              valueFrom:
                secretKeyRef:
                  name: qwixx-secrets
                  key: QWIXX_IP_HASH_SECRET
            # -- THE ONLY PLACEHOLDER IN GIT. Replace <<PUBLIC_HOSTNAME>> with the
            # -- hostname decided in Q3, no scheme, no trailing slash. Used to build
            # -- the /g/<CODE> share link. If the app derives its origin from the
            # -- request Host header instead, delete this env var entirely and the
            # -- placeholder leaves the repo.
            - name: APP_ORIGIN
              value: "https://<<PUBLIC_HOSTNAME>>"
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3000"
            - name: HOSTNAME
              value: "0.0.0.0"                 # standalone binds localhost without this and every probe fails
          volumeMounts:
            # readOnlyRootFilesystem is on, so give the runtime its scratch paths.
            - name: tmp
              mountPath: /tmp
            - name: next-cache
              mountPath: /app/.next/cache
          startupProbe:
            # Covers cold start without making the readiness probe slow forever.
            httpGet:
              path: /api/health
              port: 3000
            periodSeconds: 3
            failureThreshold: 20               # 60s budget to first byte
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /api/health
              port: 3000
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            # Sized for a tiny Next.js app serving five phones in one room.
            # Node standalone idles around 90-140Mi RSS. The limit is headroom,
            # not a target. Requests stay small so the scheduler can place it
            # anywhere: worker1 carries scriberr's models and supabase-db.
            requests:
              cpu: 50m
              memory: 160Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: tmp
          emptyDir: {}
        - name: next-cache
          emptyDir: {}
```

**Probe contract.** `/api/health` must not touch the database. If it does, a Supabase blip restarts every qwixx pod through the liveness probe and turns a degraded app into a down app. This is the same class of mistake as the vexa liveness gate in `lessons.md`: alive and working are not the same thing to a probe, and the wrong gate makes it worse.

**If the pod CrashLoops with `EROFS` or `EACCES` on first deploy**, `readOnlyRootFilesystem: true` is the cause and the app writes somewhere I did not anticipate. Find the path in the logs, add an `emptyDir` for it. Only if that fails twice, drop `readOnlyRootFilesystem` and write the reason in a manifest comment. Do not drop it silently.

### The SealedSecret contract

Secret name `qwixx-secrets`, namespace `qwixx`, exactly three keys. Key names match the environment variable names the app reads (`lib/cookies.ts`, `lib/ipHash.ts`) exactly — the app throws at startup (`instrumentation.ts`) and `/api/health` returns 503 rather than serving traffic if any of the three is missing, too short, or still the `.env.example` placeholder, but a wrong key name in this Secret still means a broken deploy, so get the name right here.

| Key | What it is | Source |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | The existing Supabase service role JWT. **Do not mint a new one.** It is already sealed as key `SERVICE_ROLE_KEY` inside `namespaces/supabase/sealed-secret.yaml` and the plaintext is in 1Password under *k3s - Supabase*. Copy that same value into the qwixx secret. | 1Password, *k3s - Supabase* |
| `QWIXX_COOKIE_SECRET` | New value. Signs the two httpOnly cookies from `intent.md`, the per-game seat cookie and the durable `player_id` cookie. Generate with `openssl rand -base64 48`. Store in 1Password under a new item *k3s - Qwixx* before sealing. | new, 1Password *k3s - Qwixx* |
| `QWIXX_IP_HASH_SECRET` | New value. HMAC key for `hashIp()` — the raw client IP is never stored, only this digest, keyed by this secret, used for the rate limiter (finding S1/S7). Generate with `openssl rand -base64 48`. Store in 1Password under the same *k3s - Qwixx* item as a second field. | new, 1Password *k3s - Qwixx* |

No raw value appears in this spec, in any manifest, or in any commit.

Sealing is scope-strict. The ciphertext binds to both the namespace and the secret name. Renaming either later means resealing. Run on the MacBook:

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
export KUBECONFIG=~/.kube/luwah-tailscale.yaml && \
PATH="/opt/homebrew/bin:$PATH" kubectl create secret generic qwixx-secrets -n qwixx \
  --dry-run=client \
  --from-literal=SUPABASE_SERVICE_ROLE_KEY="$SRK" \
  --from-literal=QWIXX_COOKIE_SECRET="$CSS" \
  --from-literal=QWIXX_IP_HASH_SECRET="$IHS" \
  -o yaml | \
kubeseal --controller-name=sealed-secrets-controller --controller-namespace=kube-system \
  --format=yaml > namespaces/qwixx/sealed-secret.yaml
```

`kubeseal` is at `/opt/homebrew/bin/kubeseal` and is **not on PATH**. The `PATH=` prefix is required, not decorative. `kubectl create secret --dry-run=client` builds the plaintext Secret in memory and never sends it to the cluster. Set `SRK`, `CSS`, and `IHS` as shell variables first and `unset` them after, so none lands in a file.

Verify before committing:

```
[MacBook] grep -c encryptedData /Users/theafrooverlander/code/luwah-k3s/namespaces/qwixx/sealed-secret.yaml && \
grep -L "kind: Secret$" /Users/theafrooverlander/code/luwah-k3s/namespaces/qwixx/sealed-secret.yaml
```

If the file says `kind: Secret` rather than `kind: SealedSecret`, kubeseal did not run and you are about to commit plaintext. Stop.

Rotation gotcha, from `secrets-with-sealed-secrets.md` lines 76 to 110: resealing does **not** restart the pod. If `QWIXX_COOKIE_SECRET` is ever rotated, `kubectl rollout restart deploy/qwixx -n qwixx` is a second required step, and every player's cookie is invalidated so every in-progress game loses its seats. Rotate between games, not during one. `QWIXX_IP_HASH_SECRET` rotation is lower stakes — no cookie is signed with it — but still needs the same rollout restart, and it resets every in-flight rate-limit bucket (a new hash for the same IP starts a fresh counter). Rotate it whenever `QWIXX_COOKIE_SECRET` is rotated, for the same "between games" reason: a mid-game restart also drops that game's seat cookies.

---

## 3. The Cloudflare Tunnel

Copied from `namespaces/pwpush/cloudflared.yaml` with three changes: name, namespace, secret name. Nothing else differs. That file is the only working precedent on this cluster and it stays the template.

### `namespaces/qwixx/cloudflared.yaml`

```yaml
---
# Cloudflare Tunnel connector for qwixx only. Second public luwahdc-class host
# on this cluster after pwpush, same pattern, same narrow scope.
#
# The tunnel's published route is set in the Cloudflare dashboard, not here, and
# it points at exactly one origin:
#
#     http://qwixx.qwixx.svc.cluster.local:3000
#
# It MUST NOT point at supabase-kong, at 192.168.10.20:30103, or at any node IP.
# Kong's declarative config still carries a catch-all route at path "/" to
# supabase-studio guarded only by basic-auth (namespaces/supabase/manifest.yaml,
# supabase-kong-config ConfigMap, lines 578-589). Publishing Kong through any
# tunnel publishes a database admin UI behind one password. It is a standing
# ruling that Supabase stays private. Do not add a second ingress rule here.
#
# Stateless connector, no PVC, no nodeSelector. Runs anywhere.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared-qwixx
  namespace: qwixx
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudflared-qwixx
  template:
    metadata:
      labels:
        app: cloudflared-qwixx
    spec:
      automountServiceAccountToken: false
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:2026.8.2   # match the tag live on pwpush; verify on Docker Hub before pinning
          imagePullPolicy: IfNotPresent
          args:
            - tunnel
            - --no-autoupdate
            - run
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflared-qwixx
                  key: TUNNEL_TOKEN
          resources:
            requests:
              cpu: 25m
              memory: 32Mi
            limits:
              cpu: 250m
              memory: 128Mi
```

Diff against `namespaces/pwpush/cloudflared.yaml`, line for line:

```
- metadata.name:                    cloudflared-pwpush        -> cloudflared-qwixx
- metadata.namespace:               pwpush                    -> qwixx
- spec.selector.matchLabels.app:    cloudflared-pwpush        -> cloudflared-qwixx
- template.metadata.labels.app:     cloudflared-pwpush        -> cloudflared-qwixx
- env[0].valueFrom.secretKeyRef.name: cloudflared-pwpush      -> cloudflared-qwixx
  image, args, resources, automountServiceAccountToken:       identical, unchanged
```

Note the pwpush manifest at line 28 pins `cloudflare/cloudflared:2026.8.2` while `docs/.../pwpush.md` line 7 still says `2026.7.2`. The manifest is authoritative and the doc is stale. Match the manifest, and check Docker Hub for anything newer before pinning.

### `namespaces/qwixx/cloudflared-sealed-secret.yaml`

SealedSecret named `cloudflared-qwixx` in namespace `qwixx`, one key `TUNNEL_TOKEN`. Same shape as `namespaces/pwpush/cloudflared-sealed-secret.yaml`.

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
export KUBECONFIG=~/.kube/luwah-tailscale.yaml && \
PATH="/opt/homebrew/bin:$PATH" kubectl create secret generic cloudflared-qwixx -n qwixx \
  --dry-run=client --from-literal=TUNNEL_TOKEN="$TT" -o yaml | \
kubeseal --controller-name=sealed-secrets-controller --controller-namespace=kube-system \
  --format=yaml > namespaces/qwixx/cloudflared-sealed-secret.yaml
```

Store the token in 1Password under *k3s - Qwixx* first. A tunnel token grants the ability to serve traffic as that hostname. Treat it like a credential.

### The hostname, all three places it is typed

The placeholder exists **once** in Git. The other two are outside Git and there is no way around that.

| # | Where | In Git? | What |
|---|---|---|---|
| 1 | `namespaces/qwixx/manifest.yaml`, `APP_ORIGIN` | yes, the only one | `https://<<PUBLIC_HOSTNAME>>`. Delete this env var entirely if the app derives its origin from the request Host header, and then Git holds zero placeholders. |
| 2 | Cloudflare Zero Trust dashboard, tunnel `qwixx`, Public Hostname tab | no, dashboard state | Hostname `<<PUBLIC_HOSTNAME>>`, Service `HTTP`, URL `qwixx.qwixx.svc.cluster.local:3000`. Cloudflare creates the DNS record itself. |
| 3 | Uptime Kuma UI, HTTPS monitor | no, Kuma SQLite | See section 8. |

Add row 2 to the Git-side record table in `docs/luwah-k3s-cluster/40-operations/luwahdc-k3s-wave.md` in the same commit, so the next person can find it. NPM host config lives in NPM's own database and Cloudflare's lives in Cloudflare's, so a Git table is the only inventory that exists.

### Two tunnel failure modes worth designing for now

**Protocol confusion.** cloudflared terminates TLS at Cloudflare and forwards plain HTTP to the pod. Next.js sees `http`. If the app sets its httpOnly cookies with an auto-detected `secure` flag it will emit `Secure: false`, and the cookie then rides in cleartext on any non-tunnel path. Set `secure: true` explicitly in the cookie options, or trust the `X-Forwarded-Proto: https` header cloudflared sets. This is a real bug class, not theory. It is invisible in testing because the cookie still works.

**Retired-hostname rot.** `lessons.md` 2026-07-28 records the Outlook calendar push dying silently for 18 days because a retired `n8n-luwah.duckdns.org` host was still registered with an external service. When this hostname is decided, it is registered with Cloudflare, an external service. If it ever changes, grep the whole estate including this manifest, the Kuma monitor, and the Cloudflare dashboard.

---

## 4. CRITICAL: keeping Supabase and Kong off the internet

### 4.1 What the supabase Service is today, and whether it is reachable from outside

`namespaces/supabase/manifest.yaml` lines 78 to 92, verbatim:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: supabase-kong
  namespace: supabase
spec:
  # Only NodePort in this namespace. Kong fronts both the API (Studio talks
  # through it too) so nothing else needs external exposure.
  type: NodePort
  selector:
    app: supabase-kong
  ports:
    - port: 8000
      targetPort: 8000
      nodePort: 30103
```

It is a NodePort. **A NodePort on this cluster is not reachable from the internet.** The nodes sit on private VLAN 10 behind a residential connection with no port forward. `docs/luwah-k3s-cluster/10-architecture/networking.md` line 63: "There is no public edge beyond the single pwpush tunnel." Reach for `192.168.10.20:30103` is LAN plus Tailscale, and nothing else. Supabase has no `*.luwahdc.com` hostname by explicit ruling, and even if it did, every NPM proxy host carries a `lan-only` access list that 403s off-LAN requests.

**Nothing needs to change.** Leave `supabase-kong` exactly as it is.

The one thing that could break this is the tunnel, and only by operator error. The rule is one sentence: **the qwixx tunnel gets exactly one public hostname and exactly one origin, `qwixx.qwixx.svc.cluster.local:3000`.** Adding a second ingress rule for `supabase-kong` would publish Kong's `/` catch-all to Studio to the internet behind a single basic-auth password. That is the exact scenario the private ruling exists to prevent.

`intent.md` line 53 says Supabase and Kong "stay ClusterIP". They are NodePort today, not ClusterIP. That is a factual mismatch, but not a security one, because a NodePort on a private VLAN with no port forward is not public. Converting Kong to ClusterIP would remove the IP-only Studio access path the operator uses today and gains nothing against the actual threat. Do not convert it. Flagging the mismatch rather than acting on it.

### 4.2 The in-cluster URL, and the PostgREST schema blocker

Read from the manifests, not guessed:

```
SUPABASE_URL = http://supabase-kong.supabase.svc.cluster.local:8000
```

Service `supabase-kong` (line 81), namespace `supabase` (line 82), port `8000` (line 90). The short form `http://supabase-kong:8000` resolves only from inside the `supabase` namespace, which is what `supabase-studio` uses. From `qwixx` the fully qualified name is required.

**Now the blocker.** `namespaces/supabase/manifest.yaml` lines 908 to 913:

```yaml
            - name: PGRST_DB_URI
              value: postgres://authenticator:$(DB_PASSWORD)@supabase-db:5432/postgres
            - name: PGRST_DB_SCHEMAS
              value: public,storage,graphql_public
            - name: PGRST_DB_ANON_ROLE
              value: anon
```

`qwixx` is absent. Required edit:

```diff
             - name: PGRST_DB_SCHEMAS
-              value: public,storage,graphql_public
+              # qwixx added 2026-09-01 for the qwixx-scoresheet app. PostgREST
+              # answers 406 to an Accept-Profile it was not configured with, so
+              # every supabase-js .schema('qwixx') call fails without this.
+              # Additive only: the three existing schemas are unchanged.
+              value: public,storage,graphql_public,qwixx
```

Then, because a Deployment env change does roll the pod, Argo restarts `supabase-rest` on sync. No manual restart needed. Confirm with pod age.

The app must call `.schema('qwixx')` on the supabase-js client. Without it the client defaults to `public` and every table is missing.

### 4.3 Consumer inventory for the PGRST_DB_SCHEMAS change

I grepped the whole `namespaces/` tree for `supabase` and for `30103`. Only two files match, `namespaces/supabase/manifest.yaml` and `namespaces/supabase/sealed-secret.yaml`. No other namespace references Supabase at all. That negative result is the finding that makes this change safe.

| Consumer | Reaches PostgREST how | Uses `PGRST_DB_SCHEMAS`? | Effect of adding `qwixx` | Replacement path if broken |
|---|---|---|---|---|
| `supabase-studio` | `SUPABASE_URL=http://supabase-kong:8000`, paths `/auth/v1`, `/rest/v1`, `/storage/v1` | yes, indirectly | None. Additive. Studio's schema picker gains a `qwixx` entry. No existing schema moves. | n/a, nothing breaks |
| `supabase-kong` route `rest-v1` | proxies to `http://supabase-rest:3000/`, lines 508 to 525 | no, it is a proxy | None. Route unchanged. | n/a |
| `supabase-storage` | connects to Postgres directly, uses `PGRST_JWT_SECRET` only for token validation | no | None | n/a |
| `supabase-meta` | Studio reaches it directly at `http://supabase-meta:8080`, bypassing Kong | no | None | n/a |
| Human at `192.168.10.20:30103` | Kong `/` catch-all to Studio | no | None. Still works, still basic-auth. | n/a, unchanged |
| Uptime Kuma monitor on 30103, if one exists | HTTP check | no | None. Expected status code does not change. | n/a |
| Any other namespace | none exist | n/a | n/a | n/a |
| **New: qwixx pod** | `http://supabase-kong.supabase.svc.cluster.local:8000/rest/v1/` | **yes** | This is the change's whole purpose | n/a |

Nothing breaks. The change is purely additive and the restart of `supabase-rest` is a few seconds of 502 on `/rest/v1` in the middle of the night.

**Grants matter more than the env var.** The migrations in section 5 must grant to `service_role` **and not to `anon`**. Kong's `rest-v1` route allows both the `admin` and `anon` ACL groups (lines 520 to 525), so a holder of the anon key can address `/rest/v1/` with `Accept-Profile: qwixx`. Postgres grants are the only thing stopping them from reading the data. Explicitly:

```sql
GRANT USAGE ON SCHEMA qwixx TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA qwixx TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA qwixx TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA qwixx GRANT ALL ON TABLES TO service_role;
-- deliberately no grant to anon or authenticated
REVOKE ALL ON SCHEMA qwixx FROM anon, authenticated;
```

That is not defense in depth, that is the actual boundary. Write it into the first migration.

**GoTrue is not involved.** qwixx uses signed httpOnly cookies, not Supabase Auth. `intent.md` line 59 and the out-of-scope list confirm it. `GOTRUE_SITE_URL` and `API_EXTERNAL_URL` are set to `http://192.168.10.20:30103` at lines 822 to 839 and must stay that way. Nobody should "fix" them to the new public hostname on qwixx's account. Doing so would change magic-link behaviour for a component qwixx never touches.

### 4.4 NetworkPolicy: enforceable, and I still recommend shipping it inert

Correcting the brief. k3s bundles the kube-router network policy controller alongside flannel. `docs/luwah-k3s-cluster/10-architecture/security.md` line 62: "k3s enforces NetworkPolicy through kube-router, so the capability exists, but no policies are written." A policy written here would be enforced. It would not silently do nothing.

But **zero NetworkPolicies exist on this cluster today**. The only one in the repo is `namespaces/browser-use/manifest.yaml` lines 113 to 150, commented out and labelled "ACTIVATION-GATED (sec review L3)".

Recommendation: **do not activate one in this wave.** Reasons, in order:

1. It buys nothing against the stated threat. The threat is "Kong reachable from the internet". That is governed entirely by what the Cloudflare tunnel routes to. A policy inside the pod network cannot make Kong more or less public.
2. qwixx's first deploy would be the cluster's first live NetworkPolicy. If DNS egress is written wrong, the symptom is `getaddrinfo ENOTFOUND supabase-kong.supabase.svc.cluster.local`, which reads exactly like a Supabase outage and will be misdiagnosed. The browser-use comment already flags this: "If DNS breaks under this policy (CNI matches the service IP, not the pod IP), add a third egress".
3. A policy limiting **ingress to supabase** would be the genuinely useful one, and that is a change to a shared component owned by a different Argo Application. It belongs in its own change with its own consumer check, not bolted onto a new app's first deploy.

Ship it commented out in `namespaces/qwixx/manifest.yaml`, following the browser-use precedent exactly, with a note that it is enforceable and deliberately inert. Then raise "write the first real NetworkPolicy" as a separate item against `hardening-tiers.md`, which already lists it.

---

## 5. Applying the SQL migrations

### Real object names, verified

| Thing | Value | Source |
|---|---|---|
| Namespace | `supabase` | manifest line 612 |
| Deployment | `supabase-db` | manifest line 611 |
| Container | `postgres` | manifest line 658 |
| Pod label selector | `app=supabase-db` | manifest lines 616 to 621 |
| Database | `postgres` | `POSTGRES_DB` at lines 669 to 670 |
| Superuser | `postgres` | `POSTGRES_USER` is unset, so the image default applies. `backup-postgres.sh` line 38 confirms with `${POSTGRES_USER:-postgres}` |
| Auth inside the pod | unix socket, trust | `backup-postgres.sh` header line 13, "unix socket inside the pod as POSTGRES_USER (trust on the official images)" |
| Node | worker1, pinned | manifest lines 624 to 626 |

### Mandatory pre-change backup

This touches a database worth keeping. Take a fresh verified dump before the first migration, do not rely on the last scheduled run.

```
[master, ssh -p 4278 luwah@192.168.10.20] sudo /usr/local/bin/backup-postgres.sh 2>&1 | tail -20 && \
ls -lt "/mnt/nas-backups/Daniel Cooke/Home Lab/Backups/postgres/supabase-postgres-"*.sql.gz | head -3
```

Expect a line reading `OK   supabase/postgres (supabase-db-...) NNNNN KB` and then `ALL OK`. The script already verifies size, `gzip -t`, and the `PostgreSQL database dump complete` trailer, and deletes anything that fails. **If it does not print `ALL OK`, stop and do not run a migration.** That verification exists because immich dumps were silently truncated from 2026-07-12 to 2026-08-06 and looked fine on the shelf.

### Applying

Migrations live in the app repo at `supabase/migrations/*.sql`, numbered, applied in filename order. Stream them in over stdin. Nothing is copied into the pod.

```
[MacBook] export KUBECONFIG=~/.kube/luwah-tailscale.yaml && \
cd /Users/theafrooverlander/code/qwixx-scoresheet && \
for f in $(ls supabase/migrations/*.sql | sort); do \
  echo "== $f" && \
  kubectl -n supabase exec -i deploy/supabase-db -c postgres -- \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f - < "$f" || break; \
done
```

Four things that are load-bearing here:

- `exec -i` not `exec`. Without `-i` stdin is not attached and psql reads an empty script, reports success, and applies nothing.
- `-v ON_ERROR_STOP=1`. psql's default is to continue past errors and exit 0. Without this a half-applied migration reports success.
- `|| break`. Without it a failed migration is followed by the next one against a broken schema.
- `psql -f -` reads the file from stdin. `psql < file` also works but `-f -` gives better error line numbers.

Every migration must be idempotent, `CREATE SCHEMA IF NOT EXISTS qwixx`, `CREATE TABLE IF NOT EXISTS`, and so on, plus a `qwixx.schema_migrations(version text primary key, applied_at timestamptz default now())` table so a rerun is safe. This is hand-applied, not automated, so re-running the whole directory has to be harmless.

`0006_schedules.sql` (finding B3) is the one migration that is genuinely optional -- it only tries an in-database `pg_cron` schedule the deployed cleanup path (the k3s CronJob above) does not need. It needs no special handling in the loop above: every statement inside it is wrapped to turn a missing or unpreloaded `pg_cron` into a `NOTICE`, not an error, so `ON_ERROR_STOP=1` never triggers on it and `|| break` never fires because of it. Leave it in the loop. Deleting it from the run entirely is also safe, since nothing later depends on it.

Verify after:

```
[MacBook] kubectl -n supabase exec -i deploy/supabase-db -c postgres -- \
  psql -U postgres -d postgres -c "\dt qwixx.*" && \
kubectl -n supabase exec -i deploy/supabase-db -c postgres -- \
  psql -U postgres -d postgres -c "select has_schema_privilege('anon','qwixx','USAGE') as anon_can_see;"
```

`anon_can_see` must return `f`. If it returns `t` the grants in section 4.3 were not applied and the anon key can read game data through Kong.

Then confirm PostgREST actually picked the schema up. Run from inside the cluster, because Kong is not reachable from the MacBook except through the NodePort:

```
[MacBook] kubectl -n qwixx run pgrst-check --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
  curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Accept-Profile: qwixx" \
  -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
  "http://supabase-kong.supabase.svc.cluster.local:8000/rest/v1/games?limit=1"
```

`200` means the schema is exposed. `406` means `PGRST_DB_SCHEMAS` did not take, check the `supabase-rest` pod age. `401` means the key is wrong.

### pg_cron: unverified, use the CronJob

**I cannot verify pg_cron availability on `supabase/postgres:15.8.1.085` from this repo.** No manifest, doc, or init SQL in `luwah-k3s` mentions `pg_cron` or `shared_preload_libraries`. The init ConfigMap at lines 178 to 200 creates `pg_net` and `supabase_functions` and nothing else. Supabase's Postgres image generally ships pg_cron, but "generally ships" is not "is preloaded and enabled on this build", and `cron.database_name` also has to be right. I am not going to guess.

Check it if you want to know:

```
[MacBook] kubectl -n supabase exec -i deploy/supabase-db -c postgres -- \
  psql -U postgres -d postgres -c \
  "select name, default_version, installed_version from pg_available_extensions where name='pg_cron';" && \
kubectl -n supabase exec -i deploy/supabase-db -c postgres -- \
  psql -U postgres -d postgres -c "show shared_preload_libraries;"
```

pg_cron is usable only if it appears in `pg_available_extensions` **and** in `shared_preload_libraries`. If it is available but not preloaded, enabling it needs a `postgresql.conf` change and a database restart, which is a shared-component change to the only Postgres on this cluster. Not worth it for one hourly cleanup.

**Take the k3s CronJob regardless.** It is in Git, it is visible in Argo, it needs no Postgres change, and it reuses the exact credential and network path the app already uses. It triggers both cleanup functions: `qwixx.cleanup_abandoned()` (the intent's two cleanup rules) and `qwixx.cleanup_orphan_players()` (finding S1 part 3, added in `0005_orphan_players.sql`).

`namespaces/qwixx/cleanup-cronjob.yaml`

```yaml
---
# Abandoned-game cleanup, per intent.md "Resolved since intake":
#   lobby with no start after 24h  -> deleted
#   active with no sheet write 7d  -> ended, end_reason 'abandoned'
# Plus orphan-player cleanup (finding S1 part 3): a qwixx.players row with
# no game_players membership and not a winner, older than 48h, is deleted.
# All three rules live inside qwixx.cleanup_abandoned() and
# qwixx.cleanup_orphan_players(). This job only triggers them, in that
# order -- cleanup_abandoned() first so a game that just got marked
# 'abandoned' does not race the orphan check for its players in the same
# run (orphan reclaim only needs game_players/games rows to no longer
# reference the player at all, and both functions read their own
# consistent snapshot, so the order does not change correctness, but
# running the game-level cleanup first keeps the two runs easy to reason
# about from the CronJob logs).
#
# Deliberately NOT pg_cron: pg_cron availability on supabase/postgres:15.8.1.085
# is unverified, and enabling it would need a shared_preload_libraries change plus
# a restart of the cluster's only Postgres. This is cheaper and lives in Git.
# (supabase/migrations/0006_schedules.sql carries an optional, guarded
# pg_cron attempt for an environment where that extension is confirmed
# available; this CronJob is the path that is actually deployed here.)
#
# Calls PostgREST RPC rather than psql so the job needs no Postgres password.
# It reuses the service role key the app already holds, over the same cluster
# DNS path. Requires both functions to be SECURITY DEFINER with EXECUTE
# granted to service_role, and qwixx present in PGRST_DB_SCHEMAS.
apiVersion: batch/v1
kind: CronJob
metadata:
  name: qwixx-cleanup-abandoned
  namespace: qwixx
spec:
  schedule: "17 * * * *"          # hourly, off the top of the hour
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          automountServiceAccountToken: false
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
          containers:
            - name: cleanup
              image: curlimages/curl:8.11.1
              env:
                - name: SRK
                  valueFrom:
                    secretKeyRef:
                      name: qwixx-secrets
                      key: SUPABASE_SERVICE_ROLE_KEY
              command: ["sh", "-c"]
              args:
                - |
                  set -e
                  call() {
                    fn="$1"
                    code=$(curl -s -o /tmp/out -w '%{http_code}' -X POST \
                      -H "apikey: $SRK" -H "Authorization: Bearer $SRK" \
                      -H "Content-Profile: qwixx" \
                      -H "Content-Type: application/json" \
                      -d '{}' \
                      "http://supabase-kong.supabase.svc.cluster.local:8000/rest/v1/rpc/$fn")
                    echo "$fn: HTTP $code"; cat /tmp/out; echo
                    case "$code" in 2*) return 0 ;; *) return 1 ;; esac
                  }
                  # Run both regardless of the first's outcome (`|| ok=1`, not a
                  # bare call, or `set -e` would abort after the first failure
                  # and skip the second cleanup rule entirely), then fail the
                  # Job if either RPC did not return 2xx.
                  ok=0
                  call cleanup_abandoned || ok=1
                  call cleanup_orphan_players || ok=1
                  exit "$ok"
              resources:
                requests:
                  cpu: 10m
                  memory: 16Mi
                limits:
                  cpu: 100m
                  memory: 64Mi
```

The `case` block is not decoration. `curl` without `-f` exits 0 on a 404 or a 500, so the Job would report Complete while cleaning up nothing. That is the same silent-success class as the missing `ON_ERROR_STOP` above.

The function itself, in a migration:

```sql
create or replace function qwixx.cleanup_abandoned() returns void
language plpgsql security definer set search_path = qwixx, public as $$
begin
  delete from qwixx.games
   where status = 'lobby' and created_at < now() - interval '24 hours';
  update qwixx.games g set status = 'ended', ended_at = now(), end_reason = 'abandoned'
   where g.status = 'active'
     and not exists (select 1 from qwixx.sheets s
                      where s.game_id = g.id and s.updated_at > now() - interval '7 days');
end $$;
grant execute on function qwixx.cleanup_abandoned() to service_role;
revoke execute on function qwixx.cleanup_abandoned() from anon, authenticated, public;
```

`security definer` plus an explicit `set search_path` is required. A definer function without a pinned search_path is a privilege-escalation footgun.

---

## 6. Argo CD wiring

One edit. `/Users/theafrooverlander/code/luwah-k3s/cluster/argocd/applicationset-luwah-k3s.yaml`, at the end of the `directories:` list. Current lines 41 to 45:

```yaml
          # Homebox + Your-Spotify wave, 2026-07-09 (docs/homebox-yourspotify-deploy-plan.md).
          - path: namespaces/homebox
          - path: namespaces/your-spotify
          # One-time secret sharing, 2026-07-15.
          - path: namespaces/pwpush
```

Becomes:

```yaml
          # Homebox + Your-Spotify wave, 2026-07-09 (docs/homebox-yourspotify-deploy-plan.md).
          - path: namespaces/homebox
          - path: namespaces/your-spotify
          # One-time secret sharing, 2026-07-15.
          - path: namespaces/pwpush
          # Qwixx score sheet, 2026-09-01. Second Cloudflare Tunnel app after pwpush.
          - path: namespaces/qwixx
```

The ApplicationSet lives under `cluster/argocd/`, which the self-managed `argocd` Application syncs. So this change propagates itself on push. No manual `kubectl apply`.

**Two silent no-ops to plan around.** Both produce no error message.

1. `syncOptions: [CreateNamespace=false]` at line 63. Argo will not create the `qwixx` namespace. No manifest in this repo carries a `kind: Namespace` object, verified by grep across the whole tree. If the namespace does not exist, the Application shows a sync error about a missing namespace, or silently generates nothing. `kubectl create namespace qwixx` is a required manual step and it comes first.
2. `# prune intentionally off` at line 61. Deleting a manifest from Git does **not** delete the live object. Every rollback in section 9 uses an explicit `kubectl delete`. This has already bitten this repo twice, recorded in `secrets-with-sealed-secrets.md` lines 135 to 148: a vexa SealedSecret stayed live for 79 days after its file was deleted, and the `ko-pellet-data` PVC was still Bound at 140 days while a manifest comment claimed it was gone.

---

## 7. Backups: no change needed, and here is the proof

`cluster/backup/backup-postgres.sh` discovers targets like this, lines 28 to 31:

```bash
targets=$(kubectl get pods -A -o json | jq -r '
  .items[] | select(.status.phase=="Running") | . as $p
  | .spec.containers[] | select(((.env // []) | map(.name) | any(. == "POSTGRES_DB" or . == "PGDATA")))
  | [$p.metadata.namespace, $p.metadata.name, .name] | @tsv')
```

and dumps like this, line 38:

```bash
exec pg_dump -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"
```

`pg_dump -d postgres` with no `-n` flag dumps **every schema in the database**. The `qwixx` schema is inside the `postgres` database, which is already discovered through `supabase-db`'s `POSTGRES_DB=postgres` env at manifest lines 669 to 670.

**Conclusion: the qwixx schema is backed up from the moment the first migration runs. No edit to any backup script. No new CronJob. No cron entry.** Coverage is twice daily, verified with a size floor, `gzip -t`, and the `PostgreSQL database dump complete` trailer, retained 14 dumps deep at `/mnt/nas-backups/Daniel Cooke/Home Lab/Backups/postgres/supabase-postgres-*.sql.gz`.

Two residual notes, neither blocking:

- Retention is 14 dumps at 12h intervals, so roughly **7 days** of history. If a schema corruption goes unnoticed for eight days there is nothing to restore from. Pre-existing, affects every database on the cluster, not a qwixx problem. `backups-and-restore.md` tracks it.
- The script only dumps `${POSTGRES_DB:-postgres}`, so the separate `_supabase` database created by the init SQL at manifest lines 178 to 181 is **not** dumped. Pre-existing gap, unrelated to qwixx, worth an issue.

The app data itself is doubly safe: every device holds its own sheet in IndexedDB, so a Postgres restore to a 12h-old dump loses at most sync history, not the phone in someone's hand.

---

## 8. Monitoring

### The pattern here

Uptime Kuma runs in namespace `uptime-kuma`, NodePort 30088, `https://uptime-kuma.luwahdc.com`. **Monitors are not in Git.** They live in Kuma's own SQLite database on the `uptime-kuma-data-nfs` PVC. There is no manifest to edit. `adding-and-deploying-apps.md` step 8 is the runbook, and API helper scripts live in the separate luwah-pxvirt repo under `monitoring/kuma-*.py`.

### Monitors to add

Two, matching the doc's IP-monitor-plus-hostname-monitor shape. Add them in the Kuma UI, or with the helper scripts.

| # | Type | Target | Interval | Tests |
|---|---|---|---|---|
| 1 | HTTP(s) | `http://192.168.10.20:30111/api/health` | 60s | The pod itself. This is the fire-escape truth. Isolates "app is down" from "tunnel is down". Expect 200. |
| 2 | HTTP(s) | `https://<<PUBLIC_HOSTNAME>>/api/health` | 60s | The whole public path: DNS, Cloudflare edge, the cloudflared connector, the Service, the pod. Expect 200 and a valid cert. Add this only after Q3 is answered. |

Both point at `/api/health`, so keep that route cheap. Two monitors at 60s is 2880 hits a day against it.

Why both, concretely. Monitor 1 green and monitor 2 red means the tunnel or Cloudflare, not the app. Monitor 1 red means the pod. That split is the entire diagnostic value, and it is why the doc insists on keeping the IP monitor even when a hostname exists.

**Do not** add a monitor against `supabase-kong` on 30103 as part of this wave. If one already exists, leave it alone. Nothing in this spec changes its expected status code.

Kuma's heartbeat table grows and there is already a nightly 02:00 purge CronJob trimming rows older than 3 days (`namespaces/uptime-kuma/heartbeat-purge-cronjob.yaml`). Two more monitors is a rounding error against that.

---

## 9. Rollout and rollback

### Rollout, in order

Steps 1 to 3 change nothing on the cluster. Step 4 is the first destructive-capable step.

**1. [MacBook] App repo: Dockerfile, workflow, tag, and confirm the image exists.**

```
[MacBook] cd /Users/theafrooverlander/code/qwixx-scoresheet && \
git tag v0.1.0 && git push origin v0.1.0
```

Wait for the Actions run to go green, then confirm the package is visible:

```
[MacBook] docker manifest inspect ghcr.io/luwalekeah/qwixx-scoresheet:v0.1.0 > /dev/null && echo PULLABLE
```

If Q1 answered public, this works with no login. If it fails, the package is private and Path B in section 1 applies. **Do not proceed until this prints PULLABLE.** A wrong image reference is the single most common new-app failure and it wastes a full sync cycle to discover.

**2. [Cloudflare dashboard] Create the tunnel.**
Zero Trust, Networks, Tunnels, Create a tunnel, `cloudflared` type, name it `qwixx`. Copy the token straight into 1Password under *k3s - Qwixx*. Add one public hostname: `<<PUBLIC_HOSTNAME>>`, Service type `HTTP`, URL `qwixx.qwixx.svc.cluster.local:3000`. **Exactly one hostname and exactly one origin.** Do not add a second.

**3. [MacBook] Create the namespace. Argo will not.**

```
[MacBook] export KUBECONFIG=~/.kube/luwah-tailscale.yaml && \
kubectl create namespace qwixx && kubectl get ns qwixx
```

**4. [master] Pre-change database backup. Mandatory gate.**

```
[master, ssh -p 4278 luwah@192.168.10.20] sudo /usr/local/bin/backup-postgres.sh 2>&1 | tail -20
```

Must end `ALL OK`. Anything else, stop.

**5. [MacBook] Verify the NodePort is free, then seal both secrets.**
Section 2 for the port check. Section 2 and section 3 for the two `kubeseal` commands. Store both plaintexts in 1Password first. `unset` the shell variables after.

**6. [VS Code] Write the manifests.**
`namespaces/qwixx/manifest.yaml`, `cloudflared.yaml`, `cleanup-cronjob.yaml`. Edit `namespaces/supabase/manifest.yaml` for `PGRST_DB_SCHEMAS`. Edit `cluster/argocd/applicationset-luwah-k3s.yaml`. Edit `renovate.json`. Replace `<<PUBLIC_HOSTNAME>>` in the one place it appears, or delete the `APP_ORIGIN` env var.

**7. [MacBook] Commit and push. Two commits, not one.**

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
git add namespaces/supabase/manifest.yaml && \
git commit -m "supabase: expose qwixx schema through PostgREST" && \
git push origin main
```

Wait for `supabase-rest` to roll and confirm by pod age, not by the sync message:

```
[MacBook] kubectl -n supabase get pods -l app=supabase-rest && \
kubectl -n argocd get app supabase -o jsonpath='SYNC={.status.sync.status} HEALTH={.status.health.status}{"\n"}'
```

Then the app:

```
[MacBook] git add namespaces/qwixx/ cluster/argocd/applicationset-luwah-k3s.yaml renovate.json && \
git commit -m "qwixx: deploy score sheet app with dedicated Cloudflare Tunnel" && \
git push origin main
```

Separate commits so the shared-component change can be reverted on its own without touching the new app, and so `git log` on `namespaces/supabase/` stays readable.

**8. [MacBook] Watch the sync.**

```
[MacBook] kubectl -n argocd annotate app qwixx argocd.argoproj.io/refresh=hard --overwrite ; \
kubectl -n argocd get app qwixx -o jsonpath='SYNC={.status.sync.status} HEALTH={.status.health.status}{"\n"}' && \
kubectl get pods -n qwixx -o wide
```

If `app qwixx` does not exist at all, the ApplicationSet include-list edit did not land or has not synced yet. Check `kubectl -n argocd get app argocd`. That is the self-managed app that carries the ApplicationSet.

Expect three workloads eventually: `qwixx`, `cloudflared-qwixx`, and a CronJob that has not fired yet.

**9. [MacBook] Apply the migrations.** Section 5. Then run the two verification queries, including the `anon_can_see` check, and the in-cluster PostgREST 200 check.

**10. [MacBook] Smoke test both paths.**

```
[MacBook] curl -s -o /dev/null -w 'nodeport %{http_code}\n' http://192.168.10.20:30111/api/health && \
curl -s -o /dev/null -w 'tunnel   %{http_code}\n' https://<<PUBLIC_HOSTNAME>>/api/health
```

Then the negative test that actually matters:

```
[MacBook] curl -s -o /dev/null -w 'kong-via-tunnel %{http_code}\n' https://<<PUBLIC_HOSTNAME>>/rest/v1/
```

This must **not** return 200 with data. A 404 from Next.js is correct. If it returns Supabase JSON, the tunnel has a second ingress rule and Kong is public. Tear the tunnel down immediately.

**11. [Uptime Kuma UI] Add the two monitors.** Section 8.

**12. [VS Code, MacBook] Documentation, same wave.**
Create `docs/luwah-k3s-cluster/30-applications/qwixx.md` following the pwpush page's table shape. Add a row to the catalog table in `docs/luwah-k3s-cluster/30-applications/application-catalog.md`. Add the Cloudflare hostname row to `docs/luwah-k3s-cluster/40-operations/luwahdc-k3s-wave.md`. Stale docs mislead the next person, and this repo's docs are the first thing anyone reads.

### Rollback

**Prune is off. Reverting the commit removes nothing from the cluster.** Every step below is explicit.

Rollback A, bad image or bad app version. Cheapest, keeps everything else.

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
git revert --no-edit <qwixx-deploy-sha> && git push origin main
```

That reverts the Deployment spec but leaves the objects running on the old spec. For an immediate fix, edit the image tag back in Git and push. Do not `kubectl set image`. Argo `selfHeal: true` reverts an imperative edit within minutes and the outage returns looking spontaneous. `lessons.md` 2026-07-28 records exactly that with vexa's `RECONCILE_ACTIVE_GRACE_S`.

Rollback B, the tunnel is wrong or the app must go off the internet **now**. Fastest, seconds, no Git round trip.

```
[MacBook] kubectl -n qwixx scale deploy/cloudflared-qwixx --replicas=0
```

The public hostname stops resolving to anything within seconds. The NodePort keeps working, so the app is still reachable on LAN and Tailscale for diagnosis. `selfHeal` will scale it back to 1 on the next reconcile, so follow within minutes with either a Git change or deleting the tunnel in the Cloudflare dashboard, which is the true kill switch and is not Argo-managed.

Rollback C, back out the whole app.

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
git rm -r namespaces/qwixx && \
git checkout HEAD~1 -- cluster/argocd/applicationset-luwah-k3s.yaml renovate.json && \
git commit -m "qwixx: back out" && git push origin main
```

Then, because prune is off, delete for real:

```
[MacBook] kubectl -n argocd delete app qwixx --ignore-not-found && \
kubectl delete sealedsecret qwixx-secrets cloudflared-qwixx -n qwixx --ignore-not-found && \
kubectl delete namespace qwixx
```

Delete the **SealedSecret**, not the Secret. The controller continuously reconciles a SealedSecret into its Secret, and the Secret carries an ownerReference, so deleting the Secret alone brings it back within seconds and the delete reports success. The tell is the age resetting. Deleting the namespace is safe here **only because qwixx has no PVC.** Then delete the tunnel in the Cloudflare dashboard and the two monitors in Kuma.

Rollback D, back out the Supabase schema change.

```
[MacBook] cd /Users/theafrooverlander/code/luwah-k3s && \
git revert --no-edit <supabase-pgrst-sha> && git push origin main
```

Additive change, so reverting is clean. `supabase-rest` rolls back to three schemas and Studio is unaffected. Every qwixx query starts returning 406, which is the intended effect of this rollback.

Rollback E, drop the schema and its data. Last resort, destructive.

```
[MacBook] kubectl -n supabase exec -i deploy/supabase-db -c postgres -- \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "drop schema qwixx cascade;"
```

Do rollback D first. Dropping a schema PostgREST still advertises leaves it answering 500s. Game history is permanently gone, `intent.md` keeps ended games indefinitely, so confirm with the operator and confirm a good dump exists on the NAS first.

---

## 10. Failure modes specific to this cluster

| # | Failure | Detection | Recovery |
|---|---|---|---|
| 1 | **`app qwixx` never appears in Argo.** The include-list edit was not pushed, or the self-managed `argocd` app has not synced. | `kubectl -n argocd get app qwixx` returns NotFound with no error anywhere. Nothing in any log explains it. | Confirm `namespaces/qwixx` is in `cluster/argocd/applicationset-luwah-k3s.yaml` on `origin/main`, then `kubectl -n argocd annotate app argocd argocd.argoproj.io/refresh=hard --overwrite`. |
| 2 | **Namespace missing.** `CreateNamespace=false` and no manifest carries a Namespace object. | Argo shows a sync error naming the missing namespace, or the app reports Synced with zero resources. | `kubectl create namespace qwixx`, then hard-refresh the app. |
| 3 | **`exec format error` in the pod.** The image was built on the arm64 MacBook, the nodes are amd64. | `kubectl -n qwixx logs deploy/qwixx` shows `exec /usr/local/bin/node: exec format error`. Reads like a broken entrypoint. | Rebuild in CI, or `docker buildx build --platform linux/amd64`. Push a new tag, do not reuse the old one. |
| 4 | **Every qwixx query returns 406.** `qwixx` is not in `PGRST_DB_SCHEMAS`, or `supabase-rest` did not restart. | App logs show PostgREST 406 with a body naming the profile. The in-cluster curl check in section 5 reproduces it. | Confirm the manifest edit is on main. Check `supabase-rest` pod **age**, not the Argo sync message. If old, `kubectl -n supabase rollout restart deploy/supabase-rest`. |
| 5 | **Pods start, then the app cannot reach Supabase, cross-node only.** flannel VXLAN needs UDP 8472 and UFW must permit it from the node subnet on every node. This has already broken pod-to-pod traffic to worker2 once. | `getaddrinfo` succeeds but connections hang. Symptom follows which node qwixx landed on. `kubectl get pods -n qwixx -o wide` shows the node. | Check the UFW 8472/udp rule on the node hosting the pod. `networking.md` line 17. |
| 6 | **Tunnel up, hostname 502s.** The Cloudflare ingress rule points at a name that does not resolve, usually the short `qwixx:3000` or a stale service name. | `curl https://<<PUBLIC_HOSTNAME>>` 502 while `curl http://192.168.10.20:30111` returns 200. Kuma monitor 2 red, monitor 1 green. | Fix the origin in the Cloudflare dashboard to `qwixx.qwixx.svc.cluster.local:3000`. The NodePort is the fire escape while you fix it. |
| 7 | **cloudflared CrashLoops.** Bad or rotated `TUNNEL_TOKEN`. | `kubectl -n qwixx logs deploy/cloudflared-qwixx` shows a token or auth error. Public hostname 1033s. | Reseal `cloudflared-qwixx` from the 1Password copy and push. Then `kubectl rollout restart deploy/cloudflared-qwixx` **as a second step**, because updating a Secret does not restart pods. |
| 8 | **Cookies rejected or leaked.** The pod sees `http` behind cloudflared, so an auto-detected `secure` flag emits `Secure: false`. | Players are logged out on every request, or the cookie is visible on a non-TLS path. Silent in LAN testing. | Set the cookie `secure: true` explicitly, or trust `X-Forwarded-Proto`. App-side fix. |
| 9 | **Cleanup CronJob reports Complete but cleans nothing.** `curl` without `-f` exits 0 on 404 and 500. | Abandoned lobbies accumulate while every Job shows Complete. `kubectl -n qwixx logs job/...` shows `HTTP 404`. | The `case` guard in the manifest catches this. If it was dropped, restore it. Check `grant execute ... to service_role` on the function. |
| 10 | **Someone points the tunnel at Kong.** Kong's `/` catch-all serves Studio behind one basic-auth password. | The negative test in rollout step 10 returns Supabase JSON. Otherwise invisible until someone finds it. | Delete the extra ingress rule in the Cloudflare dashboard. Then rotate `DASHBOARD_PASSWORD` in `supabase-secrets`, because it was exposed. |
| 11 | **Master reboots or loses power.** Single control-plane node with a power-event history. NodePort and Argo both go away. | Everything unreachable at once. | The pods on the workers keep serving through the tunnel, since cloudflared holds an outbound connection and does not need the API server. This is genuinely better than the NodePort path. Recover the master per `docs/luwah-k3s-cluster/40-operations/master-rebuild-2026-08-22.md`. |
| 12 | **Argo silently reverts an imperative fix.** `selfHeal: true` on every app. | The fix works for a few minutes and the problem returns looking spontaneous. | Make every change in Git. `lessons.md` 2026-07-28 records this exact pattern with vexa. |
| 13 | **Pod CrashLoops on `EROFS`.** `readOnlyRootFilesystem: true` and the app writes to an unanticipated path. | `kubectl -n qwixx logs deploy/qwixx` shows `EROFS: read-only file system` and the path. | Add an `emptyDir` for that path. Only drop `readOnlyRootFilesystem` as a last resort, and comment the reason. |
| 14 | **Renovate opens a PR bumping our own image and auto-merges it.** `"automerge": true` at `renovate.json` line 16 and `ignoreTests: true` at line 19. | A surprise commit on main changing the qwixx image tag. | The disable rule in section 1 prevents it. If it already happened, revert and add the rule. |

---

## Summary of every file touched

**Create, in `/Users/theafrooverlander/code/luwah-k3s/`:**
- `namespaces/qwixx/manifest.yaml`
- `namespaces/qwixx/sealed-secret.yaml`
- `namespaces/qwixx/cloudflared.yaml`
- `namespaces/qwixx/cloudflared-sealed-secret.yaml`
- `namespaces/qwixx/cleanup-cronjob.yaml`
- `namespaces/qwixx/ghcr-pull-sealed-secret.yaml` (only if Q1 answers private)
- `docs/luwah-k3s-cluster/30-applications/qwixx.md`

**Edit, in `/Users/theafrooverlander/code/luwah-k3s/`:**
- `cluster/argocd/applicationset-luwah-k3s.yaml` (include list, section 6)
- `namespaces/supabase/manifest.yaml` (`PGRST_DB_SCHEMAS`, section 4.2)
- `renovate.json` (disable rule, section 1)
- `docs/luwah-k3s-cluster/30-applications/application-catalog.md`
- `docs/luwah-k3s-cluster/40-operations/luwahdc-k3s-wave.md`

**Create, in `/Users/theafrooverlander/code/qwixx-scoresheet/`:**
- `Dockerfile`
- `.github/workflows/image.yml`
- `supabase/migrations/*.sql`

**Outside Git:** Cloudflare tunnel and public hostname, two Uptime Kuma monitors, two 1Password items (*k3s - Qwixx*, plus reading *k3s - Supabase*).

**Not touched, deliberately:** the `supabase-kong` Service stays NodePort 30103. `supabase-db-data` stays 10Gi `local-path` pinned to worker1. `backup-postgres.sh` and its cron entry. No NPM proxy host. No NetworkPolicy activated.
