# LectureAI Web v1

This package contains the current LectureAI Express backend plus a functional web dashboard.

## Local
1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
2. Run `npm install`.
3. Run `npm start`.
4. Open http://localhost:3000.

## Render
Create a Render Web Service from this folder/repository.
- Build: `npm install`
- Start: `npm start`
- Environment: `OPENAI_API_KEY` = your API key

Do not commit `.env`.

## Important
This is an MVP web dashboard. It does not yet include user accounts, persistent database storage, usage limits, or Stripe subscriptions. Do not expose the API publicly without adding authentication/rate limiting before a public launch.

The Echo360 live translator remains a Chrome extension because a normal website cannot directly read arbitrary content from the Echo360 page. The web app is for transcript-based study features and account/dashboard functionality.
