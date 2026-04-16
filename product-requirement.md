# AI Video Studio — Product Requirements Document

**Version:** 1.0 — Initial Draft  
**Date:** April 2026  
**Status:** Draft  
**Phases:** 5 | **Features:** 15

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Build Sequence Overview](#2-build-sequence-overview)
3. [Phase 1 — Foundation](#3-phase-1--foundation)
4. [Phase 2 — Asset Generation](#4-phase-2--asset-generation)
5. [Phase 3 — Video Production](#5-phase-3--video-production)
6. [Phase 4 — Publishing Layer](#6-phase-4--publishing-layer)
7. [Phase 5 — Intelligence Layer](#7-phase-5--intelligence-layer)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Out of Scope (v1.0)](#9-out-of-scope-v10)
10. [Open Questions](#10-open-questions)

---

## 1. Product Overview

AI Video Studio is a web application that lets a solo creator produce high-quality, anonymous YouTube videos — in the style of Kurzgesagt or any custom visual identity — using a fully AI-powered pipeline. The user defines a style, writes or generates a script, and the app orchestrates every production step through best-in-class APIs, delivering a ready-to-publish video and YouTube metadata with minimal manual effort.

### 1.1 Vision

One creator. One prompt. One published video. No camera, no face, no studio.

### 1.2 Target User

- Solo content creators building anonymous educational or entertainment YouTube channels
- Creators running multiple channels with distinct visual identities
- Small media teams looking to reduce production cost and time

### 1.3 Core Goals

- Reduce per-video production time from 40+ hours to under 2 hours of active effort
- Allow complete visual style switching between videos via 1–3 reference image uploads
- Generate commercially safe audio (voiceover + music) with zero Content ID risk
- Publish directly to YouTube with AI-generated SEO metadata
- Build a feedback loop: YouTube analytics inform the next video's topic and pacing

### 1.4 Tech Stack Summary

| Layer | Primary | Alternatives |
|---|---|---|
| Script & AI | Claude Sonnet 4.6 | GPT-5.4, Gemini 3.1 Pro, DeepSeek V3 |
| Image generation | Google Imagen 4 / Nano Banana Pro ($0.02–0.06/img) | GPT Image 1.5, FLUX.2 Pro |
| Animation | Seedance 2.0 via fal.ai or Segmind (~$0.05/5s clip) | Runway ML, Veo 3.1, Kling 3.0 |
| Voiceover | ElevenLabs TTS | PlayHT, Murf AI |
| Music | ElevenLabs Music (commercially cleared) | AIVA (cinematic), Soundraw |
| Assembly | Shotstack API (cloud render from JSON timeline) | FFmpeg + Python |
| Captions | ElevenLabs STT (word-level timestamps) | OpenAI Whisper API |
| Thumbnails | Midjourney v8 (art) / GPT Image 1.5 (text overlay) | Imagen 4 |
| Publishing | YouTube Data API v3 | — |
| Research & SEO | vidIQ API + Claude | Perplexity AI |
| Analytics | YouTube Analytics API | — |

### 1.5 Estimated Cost Per 10-Minute Video

| Layer | Estimated Cost |
|---|---|
| Images (Imagen 4, ~30 scenes) | $2–6 |
| Animation (Seedance 2.0) | $8–20 |
| Voiceover (ElevenLabs) | $1–3 |
| Music (ElevenLabs) | $1–2 |
| Assembly (Shotstack) | $1–3 |
| **Total estimate** | **$13–34/video** |

---

## 2. Build Sequence Overview

Features are ordered to deliver a usable product as early as possible. Each phase produces a working, demonstrable output before the next begins.

- **Phase 1** → functional script + style tool
- **Phase 2** → all raw assets generated (images, voice, music)
- **Phase 3** → assembled video file ready for review
- **Phase 4** → end-to-end: prompt in, YouTube video out
- **Phase 5** → self-improving growth engine

| Phase | Feature ID | Feature Name | Priority |
|---|---|---|---|
| Phase 1 — Foundation | F-01 | Auth & Project Management | P0 |
| | F-02 | Style Profile System | P0 |
| | F-03 | Script Generation | P0 |
| Phase 2 — Asset Generation | F-04 | Image Generation | P0 |
| | F-05 | Voiceover Generation | P0 |
| | F-06 | Background Music Generation | P1 |
| Phase 3 — Video Production | F-07 | Animation & Video Clips | P0 |
| | F-08 | Video Assembly & Timeline | P0 |
| | F-09 | Auto-Subtitles & Captions | P1 |
| Phase 4 — Publishing Layer | F-10 | Thumbnail Generation | P1 |
| | F-11 | YouTube Publishing Integration | P0 |
| | F-12 | SEO Metadata Generation | P1 |
| Phase 5 — Intelligence Layer | F-13 | Research & Ideation Engine | P2 |
| | F-14 | Analytics Feedback Loop | P2 |
| | F-15 | Multi-Channel Management | P3 |

---

## 3. Phase 1 — Foundation

Build the backbone: user auth, project management, the style system, and script generation. At the end of Phase 1 the user can create a project, upload style references, and generate a structured script — ready for asset generation.

---

### F-01 — Auth & Project Management

**Priority:** P0 — Must ship first. Nothing else works without this.  
**Complexity:** Medium

**Description**  
User authentication and project workspace. Each project contains one video's worth of assets: style profile, script, generated images, audio, and final render.

**User Stories**
- As a creator, I can sign up and log in securely
- As a creator, I can create a new video project and give it a name and topic
- As a creator, I can see all my past projects and their status (Draft / Generating / Ready / Published)
- As a creator, I can delete or archive a project

**Acceptance Criteria**
- Auth via email/password + Google OAuth
- Project list view with status badge
- Each project has an isolated workspace storing all generated assets
- Soft-delete with 30-day recovery window

**Tech**  
Next.js + BetterAuth + PostgreSQL (project metadata) + S3-compatible storage (Cloudflare R2 recommended)

---

### F-02 — Style Profile System

**Priority:** P0 — Core value proposition.  
**Complexity:** Medium

**Description**  
The core differentiator. Users upload 1–3 reference images (or a short video clip) to define a visual style. Claude analyses them and generates a reusable style prompt string. This style profile is stored per-project and prepended to every image and video generation call automatically — enabling complete visual style switching between videos with zero manual prompt work.

**User Stories**
- As a creator, I can upload 1–3 images to define my video's visual style
- As a creator, I can optionally upload a short reference video clip for motion style
- As a creator, I can see Claude's generated style description and edit it if needed
- As a creator, I can save a style profile as a reusable template across projects
- As a creator, I can switch styles between videos without any manual prompt work
- As a creator, I can generate one sample image using the style before committing

**Acceptance Criteria**
- Accepts JPEG, PNG, WebP (max 10MB each); MP4 clips up to 30s for motion reference
- Claude analyses uploads and returns a style string: e.g. `flat vector, warm muted palette, thick black outlines, isometric perspective, cinematic lighting, dark background`
- Style string is editable inline before saving
- Style profile auto-attached to all subsequent generation calls in the project
- "Save as template" creates a reusable profile available across all future projects
- Preview: generate one sample image using the style before committing

**Tech**  
Claude Vision API (image analysis) + Anthropic Messages API; multipart file upload to S3; style string stored in project record

---

### F-03 — Script Generation

**Priority:** P0 — Gateway to all visual and audio generation.  
**Complexity:** Medium

**Description**  
Claude generates a full video script in a structured JSON format that feeds directly into all downstream API calls. The output includes a voiceover column, scene description column, image prompt column, and estimated duration per scene — no manual reformatting required.

**User Stories**
- As a creator, I can enter a topic and target duration (3/5/8/10 min) and receive a full script
- As a creator, I can specify tone: educational, entertaining, documentary, satirical
- As a creator, I can see the script as both a readable narrative and a structured table
- As a creator, I can edit any scene's voiceover, scene description, or image prompt inline
- As a creator, I can regenerate individual scenes without redoing the whole script
- As a creator, I can export the script as PDF or Google Doc

**Acceptance Criteria**
- Output is a JSON array: `[{ scene_id, voiceover, scene_description, image_prompt, duration_seconds }]`
- Script renders as an editable table in the UI with per-row inline editing
- Hook (first 30s) treated as a distinct section with extra iteration support
- Estimated total duration shown as a running counter
- "Regenerate scene" re-calls Claude for that row only, preserving all others
- Target word count / reading pace configurable to match desired video length

**Tech**  
Claude Sonnet 4.6 via Anthropic API; structured JSON output via system prompt; React table UI with inline editing

---

## 4. Phase 2 — Asset Generation

With a script and style profile in place, Phase 2 generates all raw assets: images per scene, voiceover audio, and background music. At the end of Phase 2 the user has all the ingredients for a full video — just not yet assembled.

---

### F-04 — Image Generation

**Priority:** P0  
**Complexity:** Medium

**Description**
For each scene in the script, generate an image using two inputs together: the scene's image_prompt text (what the scene contains) and the project's style reference images (what it should look like). The model receives both simultaneously — the text describes the subject and composition, the reference images condition the visual style. Imagen 4 is used when no reference images are available; GPT Image 1.5 or FLUX.1 Kontext is used when they are, as Imagen 4's generate endpoint is text-only and cannot accept image input.

**User Stories**
- As a creator, images are auto-generated for every scene when I click "Generate assets"
- As a creator, I can regenerate the image for any individual scene
- As a creator, I can generate 2–3 image variants per scene and pick the best
- As a creator, I can manually edit a scene's image prompt and regenerate
- As a creator, I can upload my own image to replace a generated one for a specific scene

**Acceptance Criteria**

- Each scene generates at least 1 image; user can request up to 3 variants
- Model selection is automatic based on whether a Style Profile exists:
   + Style Profile present → GPT Image 1.5 (default) or FLUX.1 Kontext; both accept image + text together
   + No Style Profile → Imagen 4 Fast (text-only prompt, style string prepended)
- Both the image_prompt text and the style reference images are passed in every call where a Style Profile exists
- Style string (from F-02) is always prepended to image_prompt regardless of model, as a reinforcing layer
- User can manually override the model per project in settings
- Generated images stored in S3, linked to scene in project DB
- Failed generations surface a retry button with the error message
- Batch generation runs all scenes in parallel (respecting API rate limits)
- Cost estimate shown before batch: "This will generate ~24 images, est. cost $0.96"

**Model behaviour summary**
Condition | Model | Inputs |
|---|---|---|
Style Profile exists | GPT Image 1.5 (default) | style reference images + image_prompt text |
Style Profile exists, high style fidelity needed | FLUX.1 Kontext | style reference images + image_prompt text |
No Style Profile| Imagen 4 Fast| image_prompt text only |

**Tech**
OpenAI Images API (GPT Image 1.5, multimodal input); FLUX.1 Kontext via fal.ai (image + text input); Google Imagen 4 Fast via Google AI Studio (text-only fallback); parallel async calls; cost tracking per project

---

### F-05 — Voiceover Generation

**Priority:** P0  
**Complexity:** Low-Medium

**Description**  
Generate voiceover audio for each scene using the `voiceover` column from the script JSON. ElevenLabs TTS produces natural, human-quality narration. Word-level timestamps are captured to enable precise video sync in Phase 3 and auto-captions in F-09.

**User Stories**
- As a creator, I can select a voice from ElevenLabs' library or clone a custom voice
- As a creator, voiceover is auto-generated scene by scene from the script's voiceover text
- As a creator, I can preview each scene's audio before proceeding
- As a creator, I can adjust speaking pace, stability, and clarity per project
- As a creator, I can re-generate the voiceover for a single scene after editing the text
- As a creator, I can select the output language for international versions

**Acceptance Criteria**
- Audio generated as MP3 per scene; stored in S3
- Word-level timestamps returned and stored (used by F-09 for captions and F-08 for sync)
- Voice library browsable with preview samples
- Voice cloning: user can upload 1–3 min of reference audio to create a custom voice
- Batch generation runs all scenes sequentially (ElevenLabs rate limits)
- Combined voiceover duration shown — warns if over/under target length by more than 15%

**Tech**  
ElevenLabs TTS API (text-to-speech endpoint with timestamps); ElevenLabs Voice Cloning API; audio stored as MP3 in S3

---

### F-06 — Background Music Generation

**Priority:** P1 — Important for quality; not a blocker for MVP demo  
**Complexity:** Low

**Description**  
Generate background music tracks using ElevenLabs Music (commercially cleared) or AIVA (cinematic/orchestral). Music is generated at the total video duration, then automatically ducked under the voiceover during assembly.

**User Stories**
- As a creator, I can describe the desired music mood and generate a matching track
- As a creator, I can choose between ElevenLabs Music (pop/ambient/electronic) and AIVA (orchestral/cinematic)
- As a creator, I can preview and regenerate until satisfied
- As a creator, I can set the music volume level relative to the voiceover (ducking level)
- As a creator, I can upload my own royalty-free track as an alternative

**Acceptance Criteria**
- Music generated at exact video duration (or next segment stitched)
- Commercial licensing confirmed for all generated tracks on paid plans
- Volume ducking configurable: 10–50% of voiceover volume during speech
- At least 3 mood quick presets: Epic, Ambient, Playful
- User can upload their own MP3/WAV as an alternative

**Tech**  
ElevenLabs Music API; AIVA API; audio duration matching via server-side FFmpeg trim/fade

> **Note:** Avoid Suno and Udio for monetised content. Both settled copyright lawsuits in late 2025 but licensing ambiguity for end-users remains. ElevenLabs Music was built on licensed training data from day one and is the only option with zero Content ID risk on YouTube.

---

## 5. Phase 3 — Video Production

Phase 3 takes all Phase 2 assets and produces a finished video: animating the images, assembling the timeline, and burning in subtitles. This is the most technically complex phase.

---

### F-07 — Animation & Video Clips

**Priority:** P0  
**Complexity:** High

**Description**  
Animate each scene's image(s) into short video clips using Seedance 2.0. Reference images from F-04 are passed as anchors via Seedance 2.0's omni-reference system to maintain style consistency across all clips. Each clip matches the scene's voiceover duration.

**User Stories**
- As a creator, each scene image is animated into a video clip automatically
- As a creator, the scene's generated images are passed as Seedance 2.0 reference anchors
- As a creator, I can describe the desired motion: "slow zoom in", "parallax pan", "dramatic pull-back"
- As a creator, I can preview each animated clip and regenerate if unsatisfied
- As a creator, clip duration matches the voiceover for that scene

**Acceptance Criteria**
- Seedance 2.0 called via fal.ai or Segmind API per scene
- Style reference images (from Style Profile) automatically included as omni-reference inputs using `@image1`, `@image2` tagging syntax
- Clip duration matches scene voiceover duration ± 1 second (loop or trim as needed)
- Clips rendered at 1080p minimum; 2K for paid tiers
- Cost estimate shown before batch generation
- Fallback: if animation fails, scene image used as a static slide with Ken Burns effect applied via FFmpeg

**Tech**  
Seedance 2.0 API (fal.ai or BytePlus); async polling for job completion; clip stored as MP4 in S3; FFmpeg for Ken Burns fallback

---

### F-08 — Video Assembly & Timeline

**Priority:** P0  
**Complexity:** High

**Description**  
Assemble all scene clips, voiceover audio, and background music into a single final MP4 using the Shotstack API. The assembly is driven by a JSON timeline auto-generated from the project's scene data — fully automated and repeatable.

**User Stories**
- As a creator, I can click "Assemble video" and receive a finished MP4 with all elements combined
- As a creator, I can preview the assembled video in the app before downloading
- As a creator, I can adjust transition style between scenes (cut, crossfade, wipe)
- As a creator, I can reorder scenes by dragging in a simple timeline view
- As a creator, I can add a custom intro and outro (upload video or image)

**Acceptance Criteria**
- Shotstack JSON timeline auto-generated from scene data (clips + voiceover timecodes + music)
- Voiceover synced to clips using ElevenLabs word-level timestamps from F-05
- Background music mixed at configured duck level during speech
- Transitions: cut (default), crossfade, wipe — user-selectable per scene or globally
- Intro/outro slots available (optional; defaults to first/last scene)
- Output: 1080p H.264 MP4, stereo AAC audio, ready for YouTube upload
- Render progress indicator shown

**Tech**  
Shotstack API (cloud render); JSON timeline builder service; FFmpeg + Python as custom fallback

---

### F-09 — Auto-Subtitles & Captions

**Priority:** P1 — Strongly recommended; boosts watch time and SEO  
**Complexity:** Low

**Description**  
Generate and burn subtitles from the voiceover's word-level timestamps (captured in F-05). Available as SRT for YouTube upload and as burned-in captions on the video.

**User Stories**
- As a creator, an SRT file is automatically generated from my voiceover timestamps
- As a creator, I can choose to burn subtitles into the video or upload SRT separately to YouTube
- As a creator, I can customise subtitle style: font, size, colour, position
- As a creator, I can edit any subtitle line before finalising

**Acceptance Criteria**
- SRT generated from ElevenLabs word-level timestamps with ±100ms accuracy
- Subtitle editor: line-by-line view with editable text and timecodes
- Burn-in option via Shotstack overlay or FFmpeg drawtext filter
- Upload to YouTube as a separate closed captions track via Data API
- Style presets: Clean White, Bold Yellow, Kurzgesagt-style, Custom

**Tech**  
ElevenLabs STT timestamps (from F-05); SRT generator service; Shotstack subtitle overlay; YouTube Captions API

---

## 6. Phase 4 — Publishing Layer

Phase 4 connects the app to YouTube — covering thumbnail creation, programmatic upload, and AI-generated SEO metadata. At the end of Phase 4 the entire pipeline is end-to-end: prompt in, published video out.

---

### F-10 — Thumbnail Generation

**Priority:** P1  
**Complexity:** Low-Medium

**Description**  
Generate click-optimised thumbnails using GPT Image 1.5 (supports text overlay) or Midjourney v8 (highest artistic quality). Claude generates the thumbnail concept from the video title and hook. Multiple variants are generated for A/B testing.

**User Stories**
- As a creator, 3 thumbnail variants are generated automatically from my video title
- As a creator, I can select my preferred variant or regenerate individual ones
- As a creator, I can specify a thumbnail concept or emotion: "shocked face", "dramatic reveal", "before/after"
- As a creator, the thumbnail style matches my project's style profile
- As a creator, I can add custom text overlay

**Acceptance Criteria**
- 3 variants generated per video by default
- Thumbnail concept auto-generated by Claude from video title + hook + style profile
- Output: 1280×720px JPG (YouTube max quality)
- Text overlay: up to 2 lines of bold text with background drop shadow
- Selected thumbnail stored and auto-uploaded during YouTube publish step
- CTR hints shown: contrast check, face presence flag, text readability score

**Tech**  
GPT Image 1.5 (text overlay support); Midjourney v8 when API becomes available; Claude for concept generation

> **Note:** Midjourney has no official public API as of April 2026. Default to GPT Image 1.5 for v1.0 and add Midjourney when their API ships.

---

### F-11 — YouTube Publishing Integration

**Priority:** P0  
**Complexity:** Medium

**Description**  
Programmatic upload to YouTube via the Data API v3. Handles video file upload, thumbnail, metadata (title, description, tags, chapters), and scheduling. Supports multiple connected YouTube channels.

**User Stories**
- As a creator, I can connect my YouTube channel via OAuth
- As a creator, I can upload my finished video to YouTube with one click
- As a creator, I can schedule a video to publish at a future date and time
- As a creator, I can set visibility: public, unlisted, private
- As a creator, video chapters are automatically generated from scene titles and timecodes
- As a creator, I can manage multiple connected channels

**Acceptance Criteria**
- YouTube OAuth 2.0 flow; token refresh handled automatically
- Resumable upload for large files (>100MB) with progress indicator
- Auto-generated chapters from scene data formatted as YouTube timestamp description
- Scheduling: publish within 6 months of upload
- Upload status tracked: Uploading / Processing / Live / Failed
- Multiple channels supported; user selects target channel per project

**Tech**  
YouTube Data API v3 (`videos.insert`, `thumbnails.set`, `captions.insert`); OAuth 2.0; resumable upload protocol

---

### F-12 — SEO Metadata Generation

**Priority:** P1  
**Complexity:** Low

**Description**  
Claude generates YouTube-optimised titles, descriptions, tags, and hashtags from the script. vidIQ validates keyword competitiveness. All metadata is editable before upload.

**User Stories**
- As a creator, 5 title variants, a description, and a full tag set are generated automatically
- As a creator, I can see keyword difficulty and search volume estimates for my target term
- As a creator, I can edit all metadata fields before publishing
- As a creator, I can save a description template (channel intro, links, disclaimers) that auto-appends to every video

**Acceptance Criteria**
- 5 title variants generated, ranked by estimated CTR
- Description: hook paragraph + timestamps + keyword-rich body + CTA + links
- Tags: 15–20 tags, mix of broad and long-tail
- Hashtags: 3–5 relevant hashtags included in description
- vidIQ keyword score shown for primary keyword
- Description template: saved once, auto-populated on every new project

**Tech**  
Claude Sonnet 4.6; vidIQ API (keyword research); metadata stored per project

---

## 7. Phase 5 — Intelligence Layer

Phase 5 turns the app from a production tool into a growth engine. Analytics from published videos feed back into ideation. A research mode surfaces winning topics before production begins. Multi-channel support enables parallel channel management.

---

### F-13 — Research & Ideation Engine

**Priority:** P2  
**Complexity:** Medium

**Description**  
A dedicated research mode powered by vidIQ trend data and Claude. The user enters a niche and receives ranked topic ideas with search volume, competition score, and a brief outline — before any production begins.

**User Stories**
- As a creator, I can enter my channel niche and receive 10 ranked video topic ideas
- As a creator, each idea shows estimated search volume, competition level, and a one-line hook
- As a creator, I can one-click start a new project from any idea
- As a creator, I receive a weekly email digest of rising topics in my niche

**Acceptance Criteria**
- 10 topic ideas generated per request, ranked by opportunity score (search volume / competition)
- Each idea includes: title, hook sentence, 3-bullet outline
- "Start project" button pre-fills the project with the topic and outline
- Weekly digest: top 5 opportunities sent via email (opt-in)

**Tech**  
vidIQ API (daily ideas, keyword research); Claude for outline generation; email via Resend or SendGrid

---

### F-14 — Analytics Feedback Loop

**Priority:** P2  
**Complexity:** High

**Description**  
Connect the YouTube Analytics API to surface per-video performance data inside the app. Claude analyses the data and surfaces actionable recommendations for the next video: which topics retained viewers longest, where drop-off occurred, which thumbnails drove the highest CTR.

**User Stories**
- As a creator, I can see views, watch time, CTR, and average view duration per published video
- As a creator, I receive AI-generated recommendations after each video reaches 500 views
- As a creator, audience retention heatmaps highlight which script sections lost viewers
- As a creator, the Research Engine prioritises topics that historically perform well for my channel

**Acceptance Criteria**
- Analytics synced daily via YouTube Analytics API
- Per-video metrics: views, CTR, AVD, impressions, likes, comments
- Audience retention graph shown with script scene timestamps overlaid
- Claude recommendation report generated when video reaches 500 views
- Research Engine weights topic suggestions using channel performance data

**Tech**  
YouTube Analytics API; Claude for analysis; Chart.js for visualisation; PostgreSQL for historical storage

---

### F-15 — Multi-Channel Management

**Priority:** P3  
**Complexity:** Medium

**Description**  
Support for multiple connected YouTube channels, each with their own style profiles, voice presets, music preferences, and analytics. Enables a single user to run parallel channels with completely distinct visual and audio identities.

**User Stories**
- As a creator, I can connect and manage up to 5 YouTube channels
- As a creator, each channel has its own default style profile, voice preset, and music preset
- As a creator, I can view analytics across all channels in a single dashboard
- As a creator, I can clone a project from one channel to another and adapt the style

**Acceptance Criteria**
- Up to 5 channels per user (configurable per pricing plan)
- Channel settings: default style profile, default voice, default music mood, upload schedule
- Cross-channel analytics dashboard: aggregate views, revenue estimate, top video
- Project clone: copies script and metadata, prompts user to select target channel's style profile

**Tech**  
Multiple YouTube OAuth tokens stored per user; channel entity in DB; scoped API calls per channel

---

## 8. Non-Functional Requirements

### Performance
- Image generation batch (~20 images): complete within 3 minutes
- Video assembly (10-min video): render within 15 minutes via Shotstack
- Page load: under 2 seconds for the project dashboard

### Cost Controls
- Per-project cost estimate shown before any generation batch runs
- Monthly spend cap per user (configurable); hard stop at cap
- Cost breakdown visible per project: images / animation / voiceover / music / assembly

### Storage
- All generated assets stored in S3-compatible storage (Cloudflare R2 recommended)
- Assets retained for 90 days after project creation; user can extend
- Max project size: 5GB (sufficient for a 15-minute 1080p video)

### Security
- All API keys stored server-side only; never exposed to the client
- YouTube OAuth tokens encrypted at rest
- User data isolated per account; no cross-user asset access
- GDPR-compliant: full data deletion on account close

### Reliability
- Generation job failures trigger automatic retry (up to 3 attempts)
- Failed scenes surfaced with retry UI — user is never blocked by a single failure
- Shotstack render failures fall back to FFmpeg local render

### Compliance
- ElevenLabs Music used for all AI-generated music to ensure zero Content ID risk on YouTube
- Suno and Udio explicitly excluded from default music options
- AI disclosure label included in YouTube description by default (editable)

---

## 9. Out of Scope (v1.0)

- Mobile app (web-only for v1.0)
- Team / collaboration features (single-user only)
- Monetisation / payment processing within the app
- Support for platforms other than YouTube (TikTok, Instagram — Phase 6 consideration)
- Real-time collaborative editing
- 3D animation or CGI rendering

---

## 10. Open Questions

1. **Pricing model:** Per-video flat fee vs. credit system vs. API cost pass-through? Credits give the cleanest UX but require accurate cost modelling per generation type.

2. **Style profile storage:** Should reference images be stored permanently or purged after the style string is extracted? Trade-off between storage cost and re-analysis flexibility.

3. **Seedance 2.0 API availability:** Currently in limited access via BytePlus and third-party providers. Need to confirm SLA and rate limits before committing to it as the sole animation provider. Runway ML should be treated as the hot-standby for v1.0.

4. **Midjourney API:** No official public API as of April 2026. Thumbnail generation defaults to GPT Image 1.5 for v1.0. Revisit when Midjourney ships an official API.

5. **YouTube channel types:** Should the app support brand accounts and multi-manager accounts, or personal channels only in v1.0?