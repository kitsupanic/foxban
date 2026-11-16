<p align="center">
  <img src="docs/images/banner.webp" alt="foxban: free real-time Kanban for Cloudflare. A cartoon fox drags a card across a Kanban board." width="100%" />
</p>

# foxban

Free, real-time Kanban for Cloudflare.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

foxban is a Kanban board that you run on your own Cloudflare account. When a teammate moves a card, you see it move right away. The free Cloudflare plan is enough for a small team.

![A foxban board called Launch week with four columns: To do, Doing, Review and Done. Each card shows its type, key and priority.](docs/images/screenshot.webp)

## What you get

- Boards with columns and cards. You drag cards to move them.
- Changes show up live for everyone on the board.
- Cards can have notes, pictures, checklists, due dates and comments.
- People join by invite only.
- If you want, cards show their GitHub branches and pull requests, and can make them.

## What you need

- A Cloudflare account. The free plan works.
- To deploy from your own computer, you also need [Node.js](https://nodejs.org) 22 or newer and [pnpm](https://pnpm.io).

## Pick how to deploy

There are two ways to deploy. Pick one.

| Way | Good for |
|---|---|
| [1. The Deploy button](#1-the-deploy-button) | The fastest start. You click and type your email. |
| [2. From your computer](#2-from-your-computer) | You want to run one command when you want to update. |

### 1. The Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kitsupanic/foxban)

1. Click the button.
2. Sign in to Cloudflare and to GitHub. Cloudflare makes a copy of foxban in your GitHub account.
3. When it asks for `ADMIN_EMAILS`, type your email.
4. Click **Deploy**. Wait for it to finish.
5. Open the link that it shows you. Then go to [Your first login](#your-first-login).

The button sets up everything that foxban needs. This includes the database (D1) and the file storage for pictures (R2).

### 2. From your computer

Get the code and install it:

```bash
git clone https://github.com/kitsupanic/foxban.git
```

```bash
cd foxban && pnpm install
```

Sign in to Cloudflare:

```bash
pnpm exec wrangler login
```

Make your settings file. Copy the example file:

```bash
cp .env.deploy.example .env.deploy
```

Open `.env.deploy` and set `ADMIN_EMAILS` to your email. You can leave the rest as it is.

Deploy:

```bash
pnpm run deploy
```

The first time, this makes the database and the file storage for you. At the end, it shows the link to your foxban.

To update later, get the new code and deploy again:

```bash
git pull && pnpm install && pnpm run deploy
```

Your `.env.deploy` file stays on your computer. Git does not send it anywhere.

## Your first login

1. Open your foxban.
2. Click **Sign up**. Use the email that you put in `ADMIN_EMAILS`.
3. Pick a password.

You are now an admin. An admin can make invite links. Send an invite link to each person who should join. Nobody can sign up without one, except admins.

Does foxban say that it has no admin yet? Then `ADMIN_EMAILS` is not set. Set it in Cloudflare (**Workers → foxban → Settings → Variables and Secrets**), and then sign up again. Pick the type **Secret**. If you pick **Text**, the next deploy wipes it out.

`ADMIN_EMAILS` can hold more than one email. Put commas between them. `*@your-company.com` makes everyone with that email an admin.

## Settings

You set these in `.env.deploy`. Only `ADMIN_EMAILS` is needed.

| Name | What it does | If you leave it out |
|---|---|---|
| `ADMIN_EMAILS` | Emails of the people who are admins. | You must set this one. Deploy stops without it. |
| `WORKER_NAME` | The name of your foxban in Cloudflare. | `foxban` |
| `D1_DATABASE_NAME` | The name of the database. | The same as `WORKER_NAME` |
| `R2_BUCKET_NAME` | The name of the file storage for pictures. | `WORKER_NAME` and then `-attachments` |
| `CUSTOM_DOMAIN` | Your own web address, like `board.example.com`. The domain must be on your Cloudflare account. | You get a `workers.dev` address. |
| `RATE_LIMIT_NAMESPACE_ID` | A number that must be different for each foxban on one Cloudflare account. | `1001` |

`.env.deploy.example` has the full list, with notes.

Be careful when you change a name later. A new name makes a new, empty foxban. Your old boards stay under the old name.

## Advanced: GitHub

You do not need this. foxban works without GitHub.

With GitHub set up, you can do three things:

- Link your GitHub account. Then your GitHub picture shows up as your picture, and you can sign in with **Log in with GitHub**. Your email and password keep working. With an invite link, you can also sign up with GitHub. An account made that way has no password. Set one in Profile, and then you can also disconnect GitHub or change your email.
- See GitHub work on cards. A branch or pull request that has the card's key in its name, title or text shows on that card, like `KR-42`. It updates in seconds, with no reload.
- Make a branch or a pull request from a card, and link a pull request by hand when it has no key.

It is one button. An admin opens **GitHub** in the account menu and presses **Create GitHub App**. GitHub asks them to confirm, and they come back to foxban. Then they press **Install on repos** and pick the repos. Those repos are connected for everyone, on all boards.

You do not need to set anything in your environment or in GitHub. foxban keeps the App's secrets for you. The first deploy makes a key to protect them. Do not change that key. If you do, the App stops working, and you make it again.

If you used the old way, with settings like `GITHUB_APP_ID`, you can delete those settings. foxban does not read them any more, and boards no longer have their own repo. Press the button once, and link your GitHub account again in **Profile**.

## Updating

Each update can change the database. You do not need to do anything for that. Every deploy updates the database for you before the new code goes live.

- **Deploy button:** your copy of foxban is a repo in your GitHub account. It is a copy, not a fork, so GitHub has no sync button for it. Pull the new code from this repo into your copy, and push it. Cloudflare deploys each push on its own:

  ```bash
  git pull https://github.com/kitsupanic/foxban.git main && git push
  ```
- **From your computer:** run `git pull && pnpm install && pnpm run deploy`.

## How it is built

- **API:** [Hono](https://hono.dev) on Cloudflare Workers. Each board is one Durable Object with its own SQLite, and it talks to browsers over hibernating WebSockets.
- **Web:** a React single-page app built with Vite.
- **Storage:** D1 for users, sessions and board metadata, R2 for attachments. Card data lives only in the board's Durable Object.
- **Agents:** an [MCP endpoint](docs/mcp.md) lets coding agents read and change boards.

## For people who want to help

- Read [CONTRIBUTING.md](CONTRIBUTING.md).
- Run it on your computer with `pnpm dev:api` and `pnpm dev:web`.
- Check your work with `pnpm typecheck` and `pnpm test`.
- [docs/architecture.md](docs/architecture.md) shows how foxban works.
- [docs/decisions/](docs/decisions/) says why it works that way.
- [AGENTS.md](AGENTS.md) has the rules for coding agents, and they help people too.
- Found a security bug? Read [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

foxban is not made by Cloudflare, and Cloudflare does not support it.
