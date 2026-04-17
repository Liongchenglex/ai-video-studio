# AI Video Studio

A web application that lets solo creators produce high-quality YouTube videos using a fully AI-powered pipeline. Define a style, generate a script, and the app orchestrates every production step — delivering a ready-to-publish video with minimal manual effort.

## Prerequisites

- **Node.js >= 20** (use `nvm use` to auto-select from `.nvmrc`)
- **PostgreSQL** running locally or remotely
- **npm** (ships with Node.js)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/Liongchenglex/ai-video-studio.git
cd ai-video-studio
```

### 2. Switch to the correct Node version

```bash
nvm use
```

If you don't have Node 20 installed:

```bash
nvm install 20
nvm use
```

### 3. Install dependencies

```bash
npm install
```

### 4. Set up environment variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string from [Neon](https://neon.tech) (e.g. `postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require`) |
| `BETTER_AUTH_SECRET` | Random secret for session encryption. Generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | App URL, `http://localhost:3000` for development |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (from Google Cloud Console) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

### 5. Set up the database

1. Sign up at [neon.tech](https://neon.tech) (free tier)
2. Create a new project and copy the connection string
3. Paste it as `DATABASE_URL` in your `.env`
4. Push the schema:

```bash
npm run db:push
```

### 6. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server with Turbopack |
| `npm run build` | Build for production |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run db:generate` | Generate Drizzle migration files |
| `npm run db:migrate` | Run pending migrations |
| `npm run db:push` | Push schema changes directly to DB (dev) |
| `npm run db:studio` | Open Drizzle Studio (DB browser) |

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Auth | BetterAuth (email/password + Google OAuth) |
| Database | PostgreSQL + Drizzle ORM |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Storage | Cloudflare R2 (S3-compatible) — future phases |

## Project Structure

```
src/
├── app/
│   ├── (auth)/           # Login and signup pages
│   ├── (dashboard)/      # Dashboard page
│   ├── projects/         # Project pages (new, [id])
│   └── api/
│       ├── auth/         # BetterAuth API handler
│       └── projects/     # Project CRUD API routes
├── components/
│   ├── ui/               # shadcn/ui components
│   ├── navbar.tsx
│   ├── project-card.tsx
│   └── project-list.tsx
├── lib/
│   ├── auth.ts           # BetterAuth server config
│   ├── auth-client.ts    # BetterAuth client config
│   ├── api-utils.ts      # Shared API helpers
│   └── db/
│       ├── index.ts      # Drizzle client
│       └── schema.ts     # Table definitions
└── middleware.ts          # Route protection
```

## Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services > OAuth consent screen**
   - Choose **External** user type
   - Fill in app name and your email
   - Add your email as a **test user** (required while in testing mode)
4. Navigate to **APIs & Services > Credentials**
5. Click **Create Credentials > OAuth 2.0 Client IDs**
6. Set application type to **Web application**
7. Add authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
8. Copy the Client ID and Client Secret to your `.env` file
