# YouTube Video/Short Analyzer (Gemini AI Powered)

An advanced web application that analyzes video files or Shorts using the Gemini API. It provides a rating/feedback on the video content, estimates the views potential, generates SEO-optimized Title, Description, and Hashtags, and outlines the correct uploading steps.

## Features
- **Video Analysis**: Upload MP4/WebM videos to evaluate pacing, visual interest, hook quality, and overall audio/video presentation.
- **AI Optimization**: Generates click-worthy, viral YouTube Titles, descriptions, and hashtags tailored to the actual visual content.
- **Upload Guide**: Detailed step-by-step instructions for uploading the specific video.
- **Premium UI**: Modern dark mode with glowing glassmorphism dashboard styling.

## Prerequisites
- Node.js installed on your machine.
- A Gemini API Key from Google AI Studio.

## Setup Instructions

1.  **Clone or Copy** the files into a directory.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create a `.env` file in the root directory:
    ```env
    GEMINI_API_KEY=your_actual_gemini_api_key_here
    PORT=3000
    ```
4.  Start the application:
    ```bash
    npm start
    ```
5.  Open [http://localhost:3000](http://localhost:3000) in your web browser.

## Deploy Backend on Render

1. Push this project to GitHub.
2. Open Render, create a new **Web Service**, and connect the GitHub repo.
3. Use these settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Health Check Path: `/api/status`
4. Add your environment variables in Render:
   - `GEMINI_API_KEY_1`
   - `GROQ_API_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
5. After Render gives your backend URL, set:
   ```env
   GOOGLE_REDIRECT_URI=https://your-render-url.onrender.com/api/youtube/oauth2callback
   ```
6. Open the Render URL directly. The app frontend and backend will both run from that same URL.
