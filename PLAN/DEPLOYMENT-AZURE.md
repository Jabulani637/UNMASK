# Deploying Unmask on Microsoft Azure

Written 2026-09-27, against `main` at commit `b4c40c0` **plus the uncommitted edits sitting
in this working tree** — the production boot gates in `api\src\config.js`, the photo-store
seam and its Cloudflare R2 driver, the backup and restore scripts, the signup screen, and this
`PLAN\` folder. That distinction matters at stage 6: a server that clones this repository
gets the commit, **not** those edits, until somebody commits and pushes them. This is an
operations plan, not a specification: it does not change what the
product promises (that stays in `PLAN\DOCUMENT\`), it says where each piece runs, in what
order to build it, and what to press to prove each step worked.

The Word version of this plan, for reading outside the code, is
`PLAN\Unmask-Deployment-Brief-Azure.docx`. It is **generated from this file** — change this
one and regenerate, never the `.docx` (`node "C:\Users\hp\Documents\Qoder\2026-09-19\94c7596b\tools\make-deployment-brief.js"`,
and `check-docx.js` beside it proves the result is a well-formed package).

Everything below is written to be typed by somebody who did not build the site. Each step
says **where** it is typed — *your laptop*, *the Azure portal*, or *the server* (an SSH
window) — and every command is the whole command, not an abbreviation of one.

---

## 0. The shape being deployed, and why this one

```
students' browsers
        |  https://<your-hostname>            (443, TLS, Let's Encrypt)
        v
+--------------------------- Azure VM, Ubuntu 24.04, South Africa North ------------------+
|  Caddy (container, port 443 + 80 public)                                               |
|        |  reverse_proxy on the compose network                                         |
|        v                                                                               |
|  api  (container: the built site + the Express API + the chat socket, port 4100         |
|        |         published on 127.0.0.1 only)                                          |
|        |  mongodb://user:pass@mongo:27017                                              |
|        v                                                                               |
|  mongo (container, mongo:7, NO published port at all)                                  |
|                                                                                        |
|  volumes:  unmask-prod_unmask-mongo-data    (the database)                             |
|            unmask-prod_unmask-photos        (photos while PHOTO_STORE=disk; a          |
|                                          bucket holds them when it says r2)            |
+----------------------|-------------------------------------------------------------------+
                       |  nightly: npm run backup -> /var/backups/unmask -> azcopy
                       v
                 Azure Blob storage container "unmask-backups"   (off-disk copies)
```

**Why a virtual machine and the shipped compose file.** The repository already contains
`deploy\docker-compose.prod.yml`, `deploy\Dockerfile` and `deploy\Caddyfile`, and all three
were rehearsed together (README, stage 9d-5). They assume exactly three things: a server
with Docker, a domain that resolves to it, and a proxy that terminates TLS. That is a VM.

**Why not Azure App Service or Azure Container Apps.** Both are good products, and both
share one property that decides where your files go: the container's own filesystem is
temporary, and is replaced on the next deploy.

- Profile photos are written either to a directory (`PHOTO_DIR=./storage/photos`, the
  `disk` driver) or to a **private bucket** (`PHOTO_STORE=r2`, the second driver).
  Both sit behind one seam — `api\src\services\photos.js` calls `save/read/unlink/sniff`
  and knows nothing about which — and there is no Azure Blob adapter. So on App Service or
  Container Apps the answer is `PHOTO_STORE=r2`, which takes the container's
  temporary filesystem out of the picture entirely; `PHOTO_DIR` simply goes unused, where
  the disk driver would have needed an Azure Files share mounted at exactly that path or
  lost every photo on the next deploy.
- `deploy\docker-compose.prod.yml` builds the site *into* the API image and serves it from
  the same process (`SERVE_WEB=1`). That is what keeps the session cookie first-party and
  the WebSocket on the same origin. Splitting it into a static web app plus an API would
  mean two origins, and `WEB_ORIGIN` — which is also the socket's handshake allowlist —
  would then have to carry both. **The rule is one origin, not one VM**: anything that
  serves the built site and the API from the same address satisfies it.
- A managed MongoDB that insists on TLS is fine: `MONGO_URL` is pasted as the provider
  prints it, `mongodb+srv://…` included, and nothing else in the build changes. The plain
  `mongodb://user:pass@mongo:27017` in the compose file is what the optional `local-db`
  profile uses inside a private Docker network, not a ceiling on the product. The one
  requirement is that the string names a database, because the backup tool reads its
  collection counts and its manifest name out of that.

Those were all real constraints when this plan was first written, and two of the three are
now gone. What is left is that none of them is *needed* to serve a few thousand students.
The right time to move off a VM is when the first real limit bites, and the README already
names which limit that is likely to be (NFR-1.3, 2,000 concurrent students, has never been
load-tested; the chat socket lives inside the API process, so one process is one unit of
scaling).

**The other route, and what it trades.** `PLAN\DEPLOY-RENDER.md` is the same product on a
host that deploys from git — Atlas for the database, a Cloudflare R2 bucket for the photos, and
still one process serving the site and the API on one origin, because that half is not
optional. It removes most of stages 2 to 5 of this document: no VM, no Docker, no SSH, no
Caddyfile, and TLS the host renews. What it gives up is the thing this document keeps
coming back to. On a VM you know where every byte is and you can carry the disk into
another machine; on a hosted tier you accept a network allow list you cannot narrow without
paying for a dedicated outbound IP, a database free tier capped at 512 MB with backups you
take by hand, an instance that sleeps after 15 idle minutes and drops every open chat
socket when it does, and no `journalctl` to read when something goes wrong at 9pm. For a
pilot at one campus those are reasonable terms; for the version a college signs on to, this
document's shape is the one to grow into.

**What this shape costs in availability:** one VM means one machine. If it is rebooted, the
site is down for the ~10 seconds it takes the containers to come back. If the disk is
destroyed, you are restoring from Blob. That is stated again in stage 13.

---

## 1. Before you touch the Azure portal: five things that must exist

| # | Thing | What it is | Why the site cannot start without it |
|---|---|---|---|
| 1 | An **Azure subscription** that can create a VM | A Pay-As-You-Go subscription, a Visual Studio (student) subscription, or an institution's subscription | Everything in stage 3 |
| 2 | A **domain name you control the DNS for** | e.g. `unmask.app`, `getunmask.co.za`, or a subdomain of a college domain. You need to be able to add an A record | TLS certificates are issued to a hostname. No DNS, no HTTPS, and no login: the session cookie is marked `Secure`, so over plain http every login looks like a wrong password (`PUBLIC_APP_URL` is a boot gate) |
| 3 | A **mail sender that gives SMTP username + password + port 587** | Recommended: **Azure Communication Services → Email**, with SMTP authentication *enabled* on the resource (this is a setting, not automatic). Any other relay works too — Brevo (free for 300 a day, and what this deployment is using), Mailgun, Amazon SES, your host's relay | Registration ends in an emailed six-digit code that has to be typed back. `SMTP_HOST` empty in production is gate **P4** and the API refuses to boot. It cannot be skipped on a server, which is deliberate |
| 4 | **SPF and DKIM** for the mail sender, published in that domain's DNS | ACS gives you two records to add after you verify the domain | Without them the confirmation emails land in spam, and a student who never sees the link never signs in — the failure looks like a broken site, not a broken mailbox |
| 5 | **Secrets you never commit** — four, or five if the photos go in a bucket | `MONGO_PASSWORD`, `SESSION_SECRET`, the SMTP password and the SSH key are yours to generate; `R2_SECRET_ACCESS_KEY` is generated *for* you by Cloudflare when the R2 API token is created. That one, with its Access Key ID, is the whole bucket's access control — it can read, write and delete every object in it, a student's face included — so both go in `deploy\prod.env` and nowhere else, and never in the site's code, where a browser could read them | `SESSION_SECRET` signs every login cookie. A 64-hex string is generated on your laptop with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

One thing to know and one thing to do before stage 3:

- **Where the code comes from.** Measured 2026-09-27, not assumed: `C:\Users\hp\Desktop\UNMASK`
  is a git repository with three commits, its remote `origin` is
  `https://github.com/Jabulani637/UNMASK`, and local `main` is level with `origin/main`
  (0 ahead, 0 behind). **The code is already on GitHub.** An anonymous request to that URL
  returns `200` while the same request for a name that does not exist returns `404`, so the
  repository is **public** — anyone can read it.
  - What that exposes was checked file by file, not assumed: 152 files are tracked, and the
    only credential-shaped ones are `.env.example` and `deploy\prod.env.example`, which hold
    no values. No `.env`, no `storage\`, no `outbox\`, no `backups\` is in the history —
    `.gitignore` excludes them and `.dockerignore` keeps them out of the image as well. What
    is readable is the code, the `PLAN\` documents and the `deploy\` files.
  - **This is good news for stage 6**: `git clone` on the server works right now, with no
    new setup, and `git pull --ff-only` in stage 10 is the whole update.
  - If you would rather it were private: the repository page → **Settings** → **General** →
    **Danger Zone** → **Change repository visibility** → Private. Say the word before you do
    it if anything else already reads from the public URL, and note that making it private
    does not un-cache what was readable while it was public — which is exactly why no real
    secret may ever be committed here.
  - **A clone is a snapshot of what is committed.** This working tree has edits that are not
    committed (the boot gates, the photo-store seam, the backup scripts, the signup screen,
    this `PLAN\` folder), so a server that clones today gets the three commits and none of
    those. Before stage 6, run `git -C C:\Users\hp\Desktop\UNMASK status -s` and read the
    list: everything in it is something the server will not have. Commit and push, then the
    clone and the later `git pull --ff-only` say the same thing as this laptop.
- **POPIA, which is a legal step and not a code step.** The product already gives you the
  mechanisms — a data access export (`/account` → Download everything we hold about you),
  a deletion that takes the whole account, a staff queue with a decision note, and a
  `/privacy` page that names the processing. What it cannot do for you is register an
  information officer with the Information Regulator, decide the lawful ground for
  processing students' personal information, or get the college's permission to let its
  students use the site. Do those three before you tell a class the address exists.

---

## 2. The Azure resources that get created

Resource group: `unmask-prod` (one group for everything, so "delete this project" is one
button and one invoice line). Region: **South Africa North** (Johannesburg) — it is the
closest Azure region to the students, and Cape Town to Johannesburg round-trips in the tens
of milliseconds.

| Resource | Name to use | Size / setting | Rough cost (check the Azure pricing calculator — these move) |
|---|---|---|---|
| Virtual machine (Linux) | `unmask-prod-vm` | Ubuntu 24.04 LTS, **Standard_D2ads_v5** (2 vCPU, 8 GiB) | ~R1,100–1,400 / month, running 24/7 |
| OS disk | (managed) | 64 GiB Premium SSD v2 or Standard SSD | ~R150–350 / month |
| Public IP address | `unmask-prod-ip` | **Static** allocation | ~R15 / month |
| Network security group | `unmask-prod-nsg` | 443 + 80 open; 22 restricted to your own address | included |
| Storage account + container | `unmaskbackup` / `unmask-backups` | Blob, LRS, with a 35-day delete-lock or lifecycle rule | ~R30–100 / month at a few GB |
| Communication Services resource | `unmask-mail` | Email, SMTP auth enabled, verified domain | first 100 recipients/day are on the free grant |
| Azure Monitor (optional) | availability test on `/api/health` | 5-minute pings | ~R0–50 / month |

Total for a live site on one machine: **roughly R1,400–R2,000 a month**, and it is dominated
by the VM. A `Standard_B2ms` (burstable, ~R500) will run the pilot honestly but shares CPU
credits: a busy evening of matching and chat can exhaust them and the whole site slows
down. Start on `D2ads_v5`; the size can be changed in the portal in five minutes with one
reboot.

---

## 3. Stage 1 — create the resource group and the VM

**Where: the Azure portal** (`portal.azure.com`).

1. Search for **Resource groups** → **Create**.
   - Subscription: yours. Resource group: `unmask-prod`. Region: **South Africa North**. Create.
2. Search for **Virtual machines** → **Create** → **Azure virtual machine**.
   - **Basics**
     - Resource group: `unmask-prod`.
     - Virtual machine name: `unmask-prod-vm`. Region: **South Africa North**.
     - Availability options: **No infrastructure redundancy required** (one VM; a
       availability set buys nothing here and costs a second machine).
     - Image: **Ubuntu Server 24.04 LTS – x86_64** (click the list and type `24.04`; the
         publisher is Canonical).
     - Size: **Standard_D2ads_v5**.
     - Authentication type: **SSH public key**. Username: `unmaskadmin`.
     - SSH public key source: **Generate new key pair**, key name `unmask-prod`, type **RSA 2048**.
     - **Click "Download private key and create resource"** and put the `.pem` file
       somewhere you will find it again. This is the key that opens the server; there is
       no second copy and no reset.
     - Inbound port rules: **Allow selected ports** → tick **HTTPS (443)** and **SSH (22)**.
       Do **not** tick HTTP (80) here; you add it in stage 4 with a comment that says why
       it is only there to redirect.
   - **Disks**: leave the OS disk as it is offered (Premium SSD v2 64 GiB is fine). Do not
     add a data disk: the database and the photos live in Docker volumes on the OS disk,
     and a second disk is one more thing to get mounted wrong on the day it matters.
   - **Networking**: the new VNet/subnet defaults are fine. Public inbound NIC: the default
     public IP — you make it static in stage 4.
   - **Management**: tick **Boot diagnostic** (storage account: create a new one; it is
     the thing you look at when the VM will not boot and you cannot SSH in).
   - Review + create → validation passes → **Create**. The first create can take ~5 minutes.

**Prove it worked:** the VM's overview page shows a **Running** status and a public IP
address. Write that IP down.

---

## 4. Stage 2 — make the address real

**Where: the Azure portal**, then your domain registrar.

1. On the VM page, click the public IP link → set **Assignment** to **Static** → **Save**.
   (A dynamic IP can change when the VM is stopped, and then your DNS record is pointing at
   somebody else's machine.)
2. Optional but useful: on the same page set a **DNS name label** such as
   `unmask-prod-abc123`. You get `unmask-prod-abc123.southafrica.cloudapp.azure.com`. It is
   not the address students type; it is the one you use to get a certificate before the
   domain is pointed, or to test if DNS is being slow.
3. **Open port 80**, so Let's Encrypt can answer its http challenge and so plain
   `http://` reaches Caddy's redirect:
   Virtual machine → **Networking** → **Create inbound port rule** →
   Name `allow-http`, Service **HTTP**, Destination port **80**, Priority 310, Action Allow.
4. **Lock SSH to your own address** (this is the single most valuable thing on this page —
   an open port 22 on the public internet gets brute-forced within hours):
   Networking → the **SSH (22)** rule → **Source** = **IP addresses** → type your current
   public IPv4 address (search "what is my ip"). Save.
   - If your connection is on mobile and your address changes, you will occasionally be
     locked out. That is the cost; the fix is to edit this rule from the Azure portal's
     **Run command** (below) rather than to open 22 to the world.
5. **DNS at your registrar**: add an **A record** for the hostname students will type —
   `@` if the bare domain, or `app` for `app.yourdomain.com` — pointing at the static IP
   from step 1. TTL 300.

**Prove it worked: from your laptop's PowerShell**

```powershell
nslookup app.yourdomain.com <the-static-IP>
nslookup app.yourdomain.com
```

The first always answers (it asks that IP directly). The second answers only once the
public DNS has caught up — that can be minutes, occasionally a few hours. Do not continue to
stage 7 until the second one prints your IP.

---

## 5. Stage 3 — get on the server and install Docker

**Where: your laptop's PowerShell.** Windows 10 and 11 ship an OpenSSH client, so this
works with no install.

```powershell
cd $env:USERPROFILE\Downloads
# If the .pem is readable by everybody, OpenSSH refuses it. This fixes that.
icacls .\unmask-prod.pem /inheritance:r /grant:r "$($env:USERNAME):(R)"
ssh -i .\unmask-prod.pem unmaskadmin@<the-static-IP>
```

You are now typing **on the server**. Everything in the remaining stages is typed there
unless a step says *your laptop*.

```bash
# 1. Get the updates that are two months old on a fresh image.
sudo apt update && sudo apt -y upgrade

# 2. Docker (engine + the compose v2 plugin). This is Docker's own documented install
#    script; it takes a minute and it is idempotent, so running it twice is harmless.
curl -fsSL https://get.docker.com | sudo sh

# 3. Let the deploy user run docker without sudo on every command below.
sudo usermod -aG docker $USER
newgrp docker      # applies the group without logging out; run it or close and reopen SSH

# 4. git, plus Node and npm on the HOST because the ops scripts (`npm run backup`,
#    `npm run restore`, `scripts/staff.js` when it is not run in the container) run there.
sudo apt -y install git nodejs npm
# AzCopy is not an apt package. Microsoft ships it as a tarball; the current link and the
# install steps are on the page below, and `aka.ms/downloadazcopy` is the short form of it.
#   https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azcopy-v10
curl -L -o azcopy.tar.gz https://aka.ms/downloadazcopy-v10-linux
tar -xzf azcopy.tar.gz --strip-components=1
sudo cp ./azcopy /usr/local/bin/azcopy && sudo chmod 755 /usr/local/bin/azcopy
azcopy --version
```

**Prove it worked**

```bash
docker --version && docker compose version && node --version && azcopy --version
docker run --rm hello-world
```

`node --version` on Ubuntu 24.04 gives Node 18, which is fine for the four scripts in
`api\scripts\` (backup, restore, staff, migrate) — they use no new syntax. The site itself
does **not** run on this Node: it runs inside the container, which is built on
`node:24-alpine` by `deploy\Dockerfile`. Do not "upgrade Node" on the host expecting it to
change the site.

---

## 6. Stage 4 — put the code on the server

**Where: the server.**

Option A — clone the repository that already exists (recommended; it is public, so this
needs no credentials on the server, and every later update is one `git pull`):

```bash
sudo mkdir -p /opt/unmask && sudo chown $USER /opt/unmask && cd /opt/unmask
git clone https://github.com/Jabulani637/UNMASK .
```

If you made the repository private in stage 1, clone with a GitHub **fine-grained personal
access token** that has read-only access to that one repository
(`https://x-access-token:<token>@github.com/Jabulani637/UNMASK`), or add the server's own SSH
key to it. A deploy key is the narrower answer: read-only, one repository, and revocable
without touching your account.

Option B — copy the folder from your laptop (*PowerShell*, nothing on the server):

```powershell
scp -i .\unmask-prod.pem -r C:\Users\hp\Desktop\UNMASK `
    unmaskadmin@<the-static-IP>:/home/unmaskadmin/unmask
ssh -i .\unmask-prod.pem unmaskadmin@<the-static-IP>
mv ~/unmask /opt/unmask 2>/dev/null || sudo mv ~/unmask /opt/unmask && sudo chown -R $USER /opt/unmask
```

Either way, check the two things the whole deployment depends on:

```bash
cd /opt/unmask
git log --oneline -1                 # which commit is this
ls deploy                            # Caddyfile  Dockerfile  docker-compose.prod.yml  nginx.unmask.conf  prod.env.example
grep -c . .env 2>/dev/null && echo "STOP: a .env reached the server"
```

The last line should print nothing. The root `.env` on your laptop holds development
secrets and must not be on a server — it would be read by the ops scripts before the
environment you set by hand (see stage 10).

---

## 7. Stage 5 — write the server's own environment file

**Where: the server.** There is exactly one new file, and it is the only file on this
machine that holds the database password and the cookie-signing key.

```bash
cd /opt/unmask
cp deploy/prod.env.example deploy/prod.env
nano deploy/prod.env        # paste the values below, then Ctrl-O, Enter, Ctrl-X
```

Fill it in like this — these are all the keys it has, and `docker compose` refuses to start
if a `:?` one is blank:

```
# ---- the database ----
# Either a hosted cluster, exactly as its console prints it:
#   mongodb+srv://<user>:<password>@<cluster>.<id>.mongodb.net/unmask?retryWrites=true&w=majority
# or the container this file can start, which needs `--profile local-db`:
#   mongodb://unmask:<password>@mongo:27017/unmask?authSource=admin
MONGO_URL=
# Read only by that local-db container, which creates the account on its very first start
# and cannot be told a different one afterwards. With a hosted database, unread.
MONGO_USER=unmask
MONGO_PASSWORD=<the strong password you generated in stage 1.5>

# ---- the profile photos ----
# `r2` keeps the bytes off this server; `disk` writes them into the mounted volume
# under api/storage/photos. Anything else is refused at boot.
PHOTO_STORE=r2
# Read only when PHOTO_STORE=r2. R2 prints this address with the bucket's name on the
# end of it (Settings tab of the bucket → S3 API); paste the whole string, the API splits
# the name off. R2_ACCOUNT_ID on its own also builds the endpoint.
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=<the bucket's exact name; connect no custom domain to it, or its pictures get a public URL>
R2_ACCESS_KEY_ID=<the R2 API token's Access Key ID>
R2_SECRET_ACCESS_KEY=<its Secret Access Key. This file only — never the site's code>
R2_TIMEOUT_MS=8000

# ---- the site, the session and the mail ----
PUBLIC_APP_URL=https://app.yourdomain.com
API_HOST_PORT=4100
SESSION_SECRET=<64 hex characters from stage 1.5>
SMTP_HOST=<your SMTP server, e.g. <resource-name>.smtp.azurecomm.net>
SMTP_PORT=587
SMTP_USER=<an ACS connection string or the SMTP username>
SMTP_PASSWORD=<the SMTP password>
MAIL_FROM=Unmask <no-reply@app.yourdomain.com>
```

| Key | What breaks if it is wrong | Where that is enforced |
|---|---|---|
| `PUBLIC_APP_URL` | Must start with `https://` and be **exactly** the address students type. It also becomes `WEB_ORIGIN`, which is both the browser allowlist *and* the chat socket's handshake allowlist — so if it is wrong, students load the page, sign in fine, and the "Live" badge on a chat never turns green | gate P1 + `api\src\realtime.js`, and a test asserts the two policies are not equal |
| `MONGO_URL` | This is the one line that decides whether the site's data lives on this server or somewhere else — nothing else in the build distinguishes a hosted database from the container. It has to **name a database** (`/unmask`), not just a server, because the backup tool reads that name out of the string and writes it in the manifest. And with a hosted cluster, this server's address has to be on the provider's network allow list or every request times out | gate (empty is a refusal) + `scripts\backupLib.js` |
| `MONGO_PASSWORD` | mongod creates this account on its **very first** start and will not accept a different one afterwards. Choose it now; changing it later means editing the deployment by hand | mongo container |
| `PHOTO_STORE`, `R2_*` | A `PHOTO_STORE` that is neither `disk` nor `r2` is a refusal, and so is `r2` with any of endpoint / bucket / Access Key ID / Secret Access Key blank — a store that quietly fell back to disk would put the pictures back on the machine that was meant to stop holding them. An `http://` endpoint is refused on its own: every photo request signs the Secret Access Key into that line, so plain http would send it unencrypted. A *complete* set that is wrong (a revoked key, a bucket renamed) is not a refusal: it shows on `/api/health` as `photoStore.writable: false` with a `reason`, not as students' blank profiles. **The key pair is the whole of the bucket's access control** — it belongs in this file and on this server, and never in the site's code, where any browser could read it | gates + `api\src\routes\health.js` |
| `SESSION_SECRET` | Under 32 characters the API refuses to boot. Changing it signs every existing student out (annoying, not dangerous) | gate P7 |
| `SMTP_*` | Empty `SMTP_HOST` in production is a refusal. A wrong password is not a refusal — it is students who never get their link, so send yourself one | gate P4 |
| `MAIL_FROM` | Must be a domain you can send from, and must not name a college — this address appears in every email a student receives | your mail provider's SPF check |
| `API_HOST_PORT` | Leave 4100. Set it to something else only if the machine already runs something on 4100 | compose |

Then make sure only you can read it, and tell git to forget it exists:

```bash
chmod 600 deploy/prod.env
git status --short          # must NOT list deploy/prod.env — .gitignore already covers it
```

**Do not add `DEV_AUTO_VERIFY`.** It is the development shortcut you may have set to `1` in
your laptop's `.env` so signing up does not need the emailed link. `NODE_ENV=production`
refuses to start the API while it is on — that is one of the ten production-only gates —
and on a server nobody has to remember to turn it off because the server never has it.

---

## 8. Stage 6 — first boot

**Where: the server.**

```bash
cd /opt/unmask
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build
```

`--build` compiles the site and the API image on the server the first time; expect 3–6
minutes (it is `npm ci` twice: once for the web build, once for the API's production
dependencies). Then watch it come up:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env logs --tail 40 api
curl -i http://127.0.0.1:4100/api/health
```

What you should see: the API's boot lines, a line saying
`• Institutions: 2 added to the collection (CPUT, …)` — on a brand-new database `api\src\index.js`
writes the starting list on the way up, which is the only way the first account can exist
at all, because nobody can register until an institution does — and `health` answering
`200` with `{"status":"ok",…}`.

If instead the container exits with a wall of text, **read it**: the fifteen configuration
refusals each name one key and one consequence ("… and every login would look like a wrong
password"). Fix that key in `deploy/prod.env` and run the same `up -d --build` again. The
database volume is untouched by a failed boot, so retrying is safe.

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env ps
```

Both services should read `Up (healthy)`. Mongo's healthcheck allows a ~40 second grace on
a first start; "starting" for a minute is normal, "unhealthy" for five is not.

---

## 9. Stage 7 — turn on HTTPS

**Where: the server.** Caddy runs as a third service in the same compose project, so there
is nothing to install and no apt repository to trust. Two edits, then one command.

**1.** Edit `deploy/Caddyfile`: change the **first line** to your hostname, and change the
proxy target from `127.0.0.1:4100` to `api:4100` — because the proxy is now *inside* the
compose network and reaches the API by service name:

```bash
cd /opt/unmask
nano deploy/Caddyfile
#   app.yourdomain.com {                     <- was: unmask.example.ac.za {
#           reverse_proxy api:4100 {         <- was: reverse_proxy 127.0.0.1:4100 {
```

**2.** Add the proxy service to `deploy/docker-compose.prod.yml`, beside `mongo:` and
`api:`, and add its two volumes to the `volumes:` block at the bottom of the file. The
volumes are where the certificate and Caddy's own config live; without them you get a new
certificate request on every deploy, and Let's Encrypt rate-limits that within a week.

```yaml
  proxy:
    image: caddy:2
    container_name: unmask-server-proxy
    restart: unless-stopped
    init: true
    depends_on:
      - api
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - unmask-caddy-data:/data
      - unmask-caddy-config:/config

volumes:
  unmask-mongo-data:
  unmask-photos:
  unmask-caddy-data:
  unmask-caddy-config:
```

**3.** Start it:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d
docker compose -f deploy/docker-compose.prod.yml logs --tail 30 proxy
```

**Alternative, if you would rather Caddy ran on the host** (a machine that already has a
web server, or a case where you want one system service for TLS): install Caddy from your
Ubuntu image's package, copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, leave the proxy
target as `127.0.0.1:4100` — which is exactly what the shipped file says, and why the API
publishes `127.0.0.1:4100` — and then `sudo systemctl enable --now caddy && sudo systemctl
reload caddy`, watching `sudo journalctl -u caddy -n 30`. Do not run both: two processes
cannot bind 443.

Either way, Caddy asks Let's Encrypt for a certificate for the hostname, renews it forever,
redirects http→https by itself, and passes `Upgrade` through without being told — which is
why the shipped config is short. Two prerequisites for the certificate, both already done
above: the A record must resolve **from the public internet** to this IP, and port 80 must
be open (stage 4.3), because that is how Let's Encrypt proves you own the name.

**Prove it worked: from your laptop's PowerShell**

```powershell
curl.exe -I https://app.yourdomain.com/api/health
curl.exe -I http://app.yourdomain.com/
```

The first must print `HTTP/1.1 200 OK` (or `HTTP/2 200`) with
`Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy` and `Cache-Control: no-store` in the headers. The second must be a
`308`/`301` to https. `Strict-Transport-Security` is present here and absent on your laptop
on purpose: the API only says it when `NODE_ENV=production`, because promising it over a
plain development port makes a browser refuse its own localhost for a month afterwards.

---

## 10. Stage 8 — the first accounts, in the only order that works

**Where: the server, plus a browser.**

1. **Register yourself in a browser.** Open `https://app.yourdomain.com`, press
   *Create a profile*, and sign up with an address at one of the institutions the first boot
   wrote in. Check that inbox — the confirmation email is the *test* of stage 7's SMTP
   settings, and it must land in the inbox, not in spam. Click the link, then sign in.
2. **Promote that account to staff. There is no route that does this, on purpose** — an
   admin session that could mint another admin is the shape of every privilege-escalation
   story this project has read about, so the change needs the database and a keyboard. Run
   the script **inside the API container**, which is already on the compose network where
   `mongo` resolves and already holds the right `MONGO_URL` in its environment:

   ```bash
   docker exec -it unmask-server-api node scripts/staff.js you@yourinstitution.ac.za
   ```

   Do not run it from the host with a `127.0.0.1` database URL: the mongo service publishes
   **no** port at all, so there is nothing on the host's loopback to connect to. The
   container's command is `node src/index.js`, but the whole API folder is in the image,
   `scripts\` included, and its working directory is already `/srv/unmask/api`. This is the
   same door to use for `migrate-institutions.js` (stage 10.4).

   The script answers with the address it promoted, and `--revoke` takes it back off.
3. **Open `/staff`** in that browser window. You should see the queue (empty), the tabs, and
   **Institutions** — where you add the college whose students you want next, and where the
   "my institution isn't listed" requests from the sign-up page arrive. A staff member adds
   an institution there and it appears on the landing page within a minute (that is the
   60-second cache on `/api/meta`) with **no redeploy and no restart**.
4. **Sign the promoted account out of nothing further and check the four staff decisions
   work**: press *Platform numbers* (aggregate counts, no student's words among them), and
   confirm you can suspend and reinstate a test account.

**Prove the whole product in five minutes**, with one friend or two browser profiles
(one normal, one incognito):

| # | Do this | You should see |
|---|---|---|
| 1 | Sign in as A, fill the profile to the completion meter's "ready", save | The institution is *read off your address*, never a field you pick |
| 2 | Sign in as B, same | A is shown B on `/match`, with the appearance line and the "after" picks on the card |
| 3 | A presses **Start chatting**, both send two messages in different windows | The badge says Live, and the other window shows the message **without a refresh** — that is the WebSocket, and it is the thing a proxy usually breaks |
| 4 | A sends a third message, presses **Ask to reveal**; B answers **yes**; A answers **yes** | `/chats/:id/reveal` shows name, photo, interests, prompts and the appearance table. Before the second yes, that route answers 403 |
| 5 | B presses **Report** on the card, then A presses **Download everything we hold about you** on `/account` | The report appears on `/staff` with the evidence copy the *server* built; the export file contains the sign-in record, the profile, the thread and the report — and the other student is written as `(another student)` |

If all five work over `https://` on the VM, the deployment is real and not a laptop demo.

---

## 11. Stage 9 — backups, and the only kind of backup worth having

The tool ships in the repository and it was proved on the laptop by restoring it, not by
writing it (README, stage 9d-3). On the server it needs three things the API container
already knows: the container name to run `mongodump` inside, a database URL that resolves
*from inside that container*, and a folder that is where the photos volume actually is.

```bash
mkdir -p /var/backups/unmask
cd /opt/unmask
MONGO_CONTAINER=unmask-server-mongo \
MONGO_URL="mongodb://unmask:<MONGO_PASSWORD>@mongo:27017/unmask?authSource=admin" \
PHOTO_DIR=/var/lib/docker/volumes/unmask-prod_unmask-photos/_data \
npm run backup -- --to /var/backups/unmask --keep 30
```

That writes `/var/backups/unmask/<stamp>-unmask/` containing `archive.gz`, `photos/` and a
`manifest.json` that counts every collection *before* anything is compressed.

The same command takes two shapes, because where the photos and the database live is now
configuration rather than fate:

- **Photos in a bucket** (`PHOTO_STORE=r2`): drop the `PHOTO_DIR=` override entirely.
  The tool asks the live store for its list and reads each object back — one request per
  photo, so a few thousand pictures is a few thousand GETs and the run is slower, not
  skipped — and the manifest records which store the bytes came from, so a restore knows
  what it is holding.
- **Database on Atlas**: there is no container to run `mongodump` inside, so
  `MONGODUMP_BIN` points at an installed MongoDB Database Tools binary (download them once
  on the VM, or run the backup from your laptop) and `MONGO_URL` is the provider's own
  `mongodb+srv://…` string. `MONGO_CONTAINER` and the in-network `mongodb://…@mongo:27017`
  URL above are only for the `local-db` profile this document assumes.

The hosted spelling of both has been unit-proven offline against a stand-in store and an
Atlas-shaped connection string, and never run against a real cluster — check it on the
first night, not at the first disaster.

Then copy it off the only disk it exists on. Create a private blob container
`unmask-backups` in the storage account from stage 2, then:

```bash
# Once, interactively, to hand azcopy a credential (a SAS token from the portal, or
# "azcopy login" if your account is an Entra ID user on this subscription):
azcopy copy '/var/backups/unmask/*' \
  'https://unmaskbackup.blob.core.windows.net/unmask-backups?<SAS-token>' --recursive

# Every night at 02:30 South Africa time, and keep the cron quiet-but-logged:
sudo crontab -e
```

```cron
30 2 * * * cd /opt/unmask && MONGO_CONTAINER=unmask-server-mongo MONGO_URL="mongodb://unmask:CHANGE_ME@mongo:27017/unmask?authSource=admin" PHOTO_DIR=/var/lib/docker/volumes/unmask-prod_unmask-photos/_data npm run backup -- --to /var/backups/unmask --keep 30 >> /var/log/unmask-backup.log 2>&1
15 3 * * * azcopy copy '/var/backups/unmask/*' 'https://unmaskbackup.blob.core.windows.net/unmask-backups?CHANGE_ME' --recursive >> /var/log/unmask-backup.log 2>&1
```

**A backup you have never restored is a file, not a backup.** Once a month, prove one:

```powershell
# Your laptop. Download the newest folder from the blob container first.
cd C:\Users\hp\Desktop\UNMASK
npm run restore -- api\backups\<that-folder> --into unmask_rehearsal
```

The tool refuses to overwrite the database the backup came from, to run with no `--into`,
to trust a folder it did not write, and to restore bytes that do not match the manifest's
hash. Read the counts it prints against the manifest, and then start the API against that
rehearsal database locally and sign a demo account in. A restore that has not produced a
sign-in is not a restore.

> **Honesty box, one item.** The backup *tool* and its restore have been run end to end
> against a real 98-document database on a laptop. The exact command above, on an Azure VM
> against the production compose stack, has **not** been run, because this machine has no
> production stack on it. Run it on the server the day you build it, before any real
> student exists, and keep the output: the three things most likely to need adjusting are
> the volume path on the `docker` group, and whether `mongodump`/`mongorestore` are present
> in the `mongo:7` image tag you get. If the tool complains, paste what it said and fix it
> then rather than assuming the cron line works because it is in a crontab.

---

## 12. Stage 10 — shipping an update, and going back

**Where: the server.** There is no CI/CD pipeline wired up — `git push` will not deploy
anything. That is a decision (the README names the missing piece), so deploys are on the
box until there is a reason for a pipeline.

```bash
cd /opt/unmask

# 0. Take a backup FIRST. A deploy that starts a new container against the same
#    database is the moment a bad migration becomes real data.
MONGO_CONTAINER=unmask-server-mongo MONGO_URL="..." PHOTO_DIR=... npm run backup -- --to /var/backups/unmask --keep 30

# 1. Name the image that is running right now, so you can go back to it.
docker tag unmask-prod-api:latest unmask-prod-api:previous

# 2. Get the new code.
git pull --ff-only

# 3. Rebuild and restart. The database and the photos are in named volumes: they survive.
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build

# 4. If the release ships a migration, run it now, in the API container:
docker exec -it unmask-server-api node scripts/migrate-institutions.js --dry-run
docker exec -it unmask-server-api node scripts/migrate-institutions.js

# 5. Prove it: health, the site, and one live chat between two windows.
curl -i http://127.0.0.1:4100/api/health
docker compose -f deploy/docker-compose.prod.yml logs --tail 30 api
```

**Rollback** is the same door, backwards:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env \
  up -d --no-build --scale api=1            # with image: previous, see below
```

Concretely: stop the new API, retag, and start again —

```bash
docker stop unmask-server-api
docker tag unmask-prod-api:previous unmask-prod-api:latest
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --no-build
```

If the data itself moved (a migration ran), rolling the code back is not enough: restore
the stage 9 folder with `--into` the live name *after* stopping the API, and say out loud
which students' messages are between the migration and the backup.

---

## 13. Stage 11 — watching it

```bash
docker stats --no-stream                                             # is the box out of memory?
docker compose -f deploy/docker-compose.prod.yml logs -f api         # what is it doing now?
docker compose -f deploy/docker-compose.prod.yml logs -f proxy       # TLS and 502s
sudo df -h /var/lib/docker /var/backups                              # a full disk is a dead database
sudo timedatectl                                                     # must be UTC; cron lines assume it
```

Log size is already capped in the compose file (`max-size: 20m`, `max-file: 5`), so
`docker compose logs` cannot eat the disk. `/api/health` answers **503** while the database
is still connecting, which is what you want an availability probe to see.

Set up an Azure Monitor **availability test** against `https://app.yourdomain.com/api/health`
every 5 minutes with an action group that emails you. It is the only alerting in this
deployment: nothing else watches a running server. `restart: unless-stopped` is the whole
of the supervision, and the plan does not pretend otherwise.

---

## 14. What this deployment does not do

Stated here so nobody discovers them in a bad week:

1. **One VM is one machine.** No second copy, no load balancer, no automatic failover. A
   host reboot is ~10 seconds of unavailability; a destroyed disk is a restore from Blob
   and whatever messages arrived since 02:30.
2. **No load test has ever been run.** The brief's NFR-1.3 (2,000 concurrent students) is
   unmeasured; the most this build has held is one rehearsal stack and one browser. Expect
   the first real constraint to be the single API process, because the chat socket lives
   inside it (NFR-6.1 is deliberately not met — it is what the file-architecture
   document's separate Python chat service would have bought).
3. **Chat is not end-to-end encrypted.** Messages are stored in the database readable by
   the process that serves them. The protections are the ones in the product: nothing
   crosses the wire that names anybody, no peer's id is in a payload, and a copy is
   deleted when its owner deletes their account. If E2EE is a requirement, it is a design
   stage, not a config flag.
4. **The site knows only that the mail server accepted a message.** There is no delivery
   log, no queue and no retry: a confirmation code, a reset link and the
   "someone tried to register with your address" warning are each handed to SMTP once. A
   full mailbox, a hard bounce or a domain whose SPF was never published is invisible here,
   and it reaches you as a student saying *I never got the email*. The recovery is the
   **Send another code** button on the confirmation step and the
   **Send me the six digits again** button on the sign-in page — one new code per address
   per minute, four per IP per half hour, and nothing else. Password reset itself **does** ship
   (`/forgot` → emailed link → new password, and every other device is signed out) — what
   does not ship is any way to know the email went nowhere.
5. **The rate limits are per IP address.** Behind a college NAT — which is exactly what a
   residence hall's wifi is — every student arrives as one address, and the wrong
   `TRUST_PROXY_HOPS` can either lock a whole building out of logging in or hand a guesser
   a fresh budget per forged header. The setting is `1` in the compose file because there
   is a proxy in front; if you ever take the proxy away, that number has to change with it.
6. **No WAF, no fail2ban, no geo-blocking.** The defences are the application's:
   eight wrong passwords lock an account, the login limiter is salted-fingerprint logged,
   operator-injection bodies are refused, Mongo publishes no port, and the only public
   ports are 443, 80 and a locked-down 22.
7. **Nobody has read this site aloud.** Accessibility is measured (contrast, focus rings,
   target sizes, headings, landmarks — `npm run a11y` plus a live browser sweep), and how
   the reveal announcement sounds in a screen reader is still manual review.
8. **A staff account cannot be made by a staff account.** That is a security decision, not
   an oversight, so "onboard a second reviewer" always means a keyboard and this plan's
   stage 8.2.

---

## Appendix A — the boot gates you will actually hit

`api\src\config.js` refuses to start a production API on twenty conditions, eleven of them
production-only. Each one names the key to edit and what goes wrong without it — and where
there is no file to edit, which is true of any host that deploys from git, the same
sentences say to set those keys as that host's environment variables instead. The ones that
catch people on a first deploy:

| Symptom on `docker compose logs api` | Key | Why it is a gate |
|---|---|---|
| "…every login would look like a wrong password" | `PUBLIC_APP_URL` starts with `http://` | The session cookie is `Secure` |
| "…chat is silently dead and nothing else looks broken" | `WEB_ORIGIN` (from `PUBLIC_APP_URL`) does not contain the address students type | The same list is the socket's handshake allowlist |
| "No mail transport is configured" | both `SMTP_HOST` and `BREVO_API_KEY` empty | A confirmation code that goes nowhere means nobody finishes signing up, quietly |
| "`BREVO_API_URL is "http://…"` | that key | The Brevo key rides in that request's headers, so it must not cross an unencrypted line |
| "`BREVO_API_KEY is set but MAIL_FROM is still …" | `MAIL_FROM` left at the address this project ships with | Brevo refuses a sender it has never seen, so every code comes back refused |
| "the template database password still in place" | `MONGO_PASSWORD` left as `change-me-local-only` | It is the first thing a scanner tries |
| "`DEV_AUTO_VERIFY` on" | that key present | A shortcut through the mailbox must not reach a server |
| "the choices are \"disk\" … or \"r2\"" | a typo in `PHOTO_STORE` | A store that silently fell back to disk would put the pictures back on the machine that was meant to stop holding them |
| "PHOTO_STORE=r2 but … are missing" | `R2_ENDPOINT` (or `R2_ACCOUNT_ID`), `R2_BUCKET`, `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` | Every upload and every photo read would fail after the site looked healthy |
| `R2_ENDPOINT is "http://…"` | that key | Every photo request signs the Secret Access Key into that line, so it must not cross an unencrypted one |
| "No .env at … and the environment has no `MONGO_URL` or `SESSION_SECRET` either" | those two | Nothing can be read and nothing can be signed. On a laptop, copy `.env.example`; on a hosted service, set them in its dashboard |

On a VM you own, `SMTP_HOST` is the door to use — nothing is blocking port 587 for you, and
a university relay becomes possible on this shape of host. `BREVO_API_KEY` is the door for a
host that restricts outbound traffic (Render's free tier blocks 25, 465 and 587 outright),
and it wins over `SMTP_HOST` when both are set.

## Appendix B — every hostname and name this plan uses

| Placeholder | Replace with | Appears in |
|---|---|---|
| `app.yourdomain.com` | your hostname | DNS A record, `PUBLIC_APP_URL`, `MAIL_FROM`, the Caddyfile's first line |
| `unmask-prod-vm` / `-ip` / `-nsg` | the resource names | the portal |
| `unmaskadmin` | the VM's Linux user | SSH, the volume ownership |
| `unmask-server-mongo` / `unmask-server-api` | the container names, fixed in the compose file | `docker exec`, `MONGO_CONTAINER` |
| `unmask-prod_unmask-mongo-data`, `unmask-prod_unmask-photos` | the named volumes, fixed by `name: unmask-prod` | backups, `PHOTO_DIR` |

Never rename the containers or the project by hand once there is data in the volumes: the
backup tool, the compose file and this plan all address them by those names, and a volume
that no one names any more is still holding all the students.
