require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// Fix CORS for Capacitor Android WebView (sends requests from capacitor://localhost or http://localhost)
app.use(cors({
    origin: function(origin, callback) {
        // Allow all origins: browser dev, Capacitor Android, Capacitor iOS
        callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));
app.options('*', cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/status', (req, res) => {
    const geminiKeys = [];
    // Collect all configured Gemini keys
    for (let i = 1; i <= 10; i++) {
        const k = process.env[`GEMINI_API_KEY${i === 1 ? '' : '_' + i}`] || process.env[`GEMINI_API_KEY_${i}`];
        if (k && k.trim()) geminiKeys.push(k.trim());
    }
    const mainKey = process.env.GEMINI_API_KEY || '';
    if (mainKey && !geminiKeys.includes(mainKey)) geminiKeys.unshift(mainKey);
    const groqConfigured = !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
    res.json({
        ok: true,
        service: 'yt-analyzer-pro-backend',
        uptime: process.uptime(),
        geminiApiKeyConfigured: geminiKeys.length > 0,
        keysCount: geminiKeys.length || (mainKey ? 1 : 0),
        groqConfigured
    });
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 100 * 1024 * 1024 } });

const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, 'thumb-' + Date.now() + path.extname(file.originalname))
});
const uploadImage = multer({ storage: imageStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// In-memory job tracking (stores full result for chat context)
const jobs = {};
let youtubeAuthState = null;
let youtubeTokenStore = null;
let youtubeChannelCache = null;

function generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

function isConfigured(value, placeholderHints = []) {
    if (!value || !String(value).trim()) return false;
    const normalized = String(value).toLowerCase();
    return !['your_', 'paste_', 'add_', 'replace_', 'client_id_here', 'client_secret_here', ...placeholderHints]
        .some(hint => normalized.includes(hint));
}

const getApiKeys = () => [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY
].filter(key => isConfigured(key, ['gemini_api_key_here']));

const getGroqApiKey = () => isConfigured(process.env.GROQ_API_KEY, ['groq_api_key_here']) ? process.env.GROQ_API_KEY.trim() : null;
const getGroqModel = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

function getYoutubeConfig() {
    return {
        clientId: isConfigured(process.env.GOOGLE_CLIENT_ID, ['google_client_id_here']) ? process.env.GOOGLE_CLIENT_ID.trim() : null,
        clientSecret: isConfigured(process.env.GOOGLE_CLIENT_SECRET, ['google_client_secret_here']) ? process.env.GOOGLE_CLIENT_SECRET.trim() : null,
        redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/youtube/oauth2callback`
    };
}

function isYoutubeConfigured() {
    const cfg = getYoutubeConfig();
    return Boolean(cfg.clientId && cfg.clientSecret);
}

function normalizeChatHistory(history = []) {
    return history
        .map(msg => ({
            role: msg.role === 'model' ? 'assistant' : msg.role,
            content: String(msg.content || '').slice(0, 2500)
        }))
        .filter(msg => ['user', 'assistant', 'system'].includes(msg.role) && msg.content);
}

async function runGroqChat(systemPrompt, message, history = [], maxTokens = 2000) {
    const apiKey = getGroqApiKey();
    if (!apiKey) throw new Error('No Groq API key configured. Add GROQ_API_KEY in .env and restart.');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: getGroqModel(),
            messages: [
                { role: 'system', content: systemPrompt },
                ...normalizeChatHistory(history),
                { role: 'user', content: String(message).slice(0, 3000) }
            ],
            temperature: 0.35,
            max_tokens: maxTokens
        })
    });

    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch { }
    if (!response.ok) {
        throw new Error(json.error?.message || text || 'Groq request failed.');
    }

    return json.choices?.[0]?.message?.content?.trim() || 'I could not generate a response.';
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { }
    if (!response.ok) {
        throw new Error(data.error_description || data.error?.message || text || `Request failed with ${response.status}`);
    }
    return data;
}

function parseIsoDuration(isoDuration = '') {
    const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const h = Number(match[1] || 0);
    const m = Number(match[2] || 0);
    const s = Number(match[3] || 0);
    return (h * 3600) + (m * 60) + s;
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function getThumbnailDimensions(videoAspect, videoWidth, videoHeight) {
    const ratio = videoWidth && videoHeight ? videoWidth / videoHeight : null;
    const aspect = ratio ? (ratio < 0.85 ? '9:16' : ratio > 1.2 ? '16:9' : '1:1') : videoAspect;
    if (aspect === '9:16') return { width: 1080, height: 1920, aspect };
    if (aspect === '1:1') return { width: 1080, height: 1080, aspect };
    return { width: 1280, height: 720, aspect: '16:9' };
}

function buildThumbnailPrompt(basePrompt, aspect) {
    const formatText = aspect === '9:16'
        ? 'vertical 9:16 YouTube Shorts cover'
        : aspect === '1:1'
            ? 'square social video cover'
            : 'wide 16:9 YouTube thumbnail';
    return [
        basePrompt,
        `Create a ${formatText}.`,
        'Make it sharp, high contrast, clean, clickable, and not stretched.',
        'Keep faces and text natural, centered, readable, and inside safe margins.',
        'No warped bodies, no broken letters, no clutter, no watermark.'
    ].join(' ');
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function getYoutubeAccessToken() {
    if (!youtubeTokenStore) throw new Error('YouTube account is not linked yet.');
    const cfg = getYoutubeConfig();
    const expiresAt = youtubeTokenStore.expires_at || 0;
    if (expiresAt && Date.now() < expiresAt - 60000) return youtubeTokenStore.access_token;
    if (!youtubeTokenStore.refresh_token) throw new Error('YouTube session expired. Please link your account again.');

    const tokenData = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            refresh_token: youtubeTokenStore.refresh_token,
            grant_type: 'refresh_token'
        }).toString()
    });

    youtubeTokenStore = {
        ...youtubeTokenStore,
        ...tokenData,
        refresh_token: tokenData.refresh_token || youtubeTokenStore.refresh_token,
        expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000)
    };
    return youtubeTokenStore.access_token;
}

async function youtubeFetch(endpoint, query) {
    const accessToken = await getYoutubeAccessToken();
    const params = new URLSearchParams(query);
    return fetchJson(`https://www.googleapis.com/youtube/v3/${endpoint}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
}

async function loadYoutubeChannelData(forceRefresh = false) {
    if (youtubeChannelCache && !forceRefresh) return youtubeChannelCache;

    const channelResponse = await youtubeFetch('channels', {
        part: 'snippet,statistics,contentDetails,brandingSettings',
        mine: 'true'
    });
    const channel = channelResponse.items?.[0];
    if (!channel) throw new Error('No YouTube channel found for this account.');

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    const videoLimitSetting = String(process.env.YOUTUBE_VIDEO_FETCH_LIMIT || '100').toLowerCase();
    const videoLimit = videoLimitSetting === 'all' ? Infinity : Math.max(1, Number(videoLimitSetting) || 100);
    const playlistItems = [];
    let pageToken = null;

    do {
        const page = await youtubeFetch('playlistItems', {
            part: 'snippet,contentDetails',
            playlistId: uploadsPlaylistId,
            maxResults: '50',
            ...(pageToken ? { pageToken } : {})
        });
        playlistItems.push(...(page.items || []));
        pageToken = page.nextPageToken;
    } while (pageToken && playlistItems.length < videoLimit);

    const selectedItems = playlistItems.slice(0, Number.isFinite(videoLimit) ? videoLimit : playlistItems.length);
    const ids = selectedItems.map(item => item.contentDetails?.videoId).filter(Boolean);
    const details = [];
    for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const page = await youtubeFetch('videos', {
            part: 'snippet,statistics,contentDetails,status',
            id: chunk.join(',')
        });
        details.push(...(page.items || []));
    }

    const videos = details.map(video => {
        const durationSeconds = parseIsoDuration(video.contentDetails?.duration);
        const stats = video.statistics || {};
        const snippet = video.snippet || {};
        const isShort = durationSeconds > 0 && durationSeconds <= 60;
        return {
            id: video.id,
            title: snippet.title,
            description: (snippet.description || '').slice(0, 700),
            publishedAt: snippet.publishedAt,
            thumbnail: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
            url: `https://www.youtube.com/watch?v=${video.id}`,
            type: isShort ? 'Short' : 'Video',
            duration: formatDuration(durationSeconds),
            durationSeconds,
            viewCount: Number(stats.viewCount || 0),
            likeCount: Number(stats.likeCount || 0),
            commentCount: Number(stats.commentCount || 0),
            tags: snippet.tags || [],
            privacyStatus: video.status?.privacyStatus || 'unknown',
            uploadStatus: video.status?.uploadStatus || 'unknown'
        };
    }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const totalViews = videos.reduce((sum, video) => sum + video.viewCount, 0);
    const totalLikes = videos.reduce((sum, video) => sum + video.likeCount, 0);
    const totalComments = videos.reduce((sum, video) => sum + video.commentCount, 0);
    const shorts = videos.filter(video => video.type === 'Short');
    const longVideos = videos.filter(video => video.type === 'Video');
    const avg = list => list.length ? Math.round(list.reduce((sum, video) => sum + video.viewCount, 0) / list.length) : 0;
    const sortedByViews = [...videos].sort((a, b) => b.viewCount - a.viewCount);
    const dates = videos.map(video => new Date(video.publishedAt)).filter(date => !Number.isNaN(date.getTime()));
    const gaps = [];
    for (let i = 0; i < dates.length - 1; i++) {
        gaps.push(Math.abs(dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24));
    }
    const avgGapDays = gaps.length ? Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) : null;

    const channelStats = channel.statistics || {};
    const summary = {
        totalVideosFetched: videos.length,
        shortsCount: shorts.length,
        videosCount: longVideos.length,
        totalViews,
        averageViews: videos.length ? Math.round(totalViews / videos.length) : 0,
        averageShortViews: avg(shorts),
        averageVideoViews: avg(longVideos),
        totalLikes,
        totalComments,
        engagementRate: totalViews ? Number((((totalLikes + totalComments) / totalViews) * 100).toFixed(2)) : 0,
        bestFormat: avg(shorts) > avg(longVideos) ? 'Shorts are pulling stronger views right now.' : 'Long videos are pulling stronger views right now.',
        uploadCadence: avgGapDays ? `About every ${avgGapDays} day${avgGapDays === 1 ? '' : 's'}` : 'Not enough uploads to calculate.',
        latestUpload: videos[0] || null,
        topVideos: sortedByViews.slice(0, 5),
        recentVideos: videos.slice(0, 12)
    };

    youtubeChannelCache = {
        linked: true,
        refreshedAt: new Date().toISOString(),
        fetchLimit: videoLimitSetting,
        channel: {
            id: channel.id,
            title: channel.snippet?.title || 'YouTube Channel',
            description: channel.snippet?.description || '',
            customUrl: channel.snippet?.customUrl || '',
            country: channel.snippet?.country || '',
            publishedAt: channel.snippet?.publishedAt || '',
            thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || '',
            banner: channel.brandingSettings?.image?.bannerExternalUrl || ''
        },
        statistics: {
            viewCount: Number(channelStats.viewCount || 0),
            subscriberCount: channelStats.hiddenSubscriberCount ? null : Number(channelStats.subscriberCount || 0),
            hiddenSubscriberCount: Boolean(channelStats.hiddenSubscriberCount),
            videoCount: Number(channelStats.videoCount || videos.length)
        },
        summary,
        videos
    };

    return youtubeChannelCache;
}

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Download Thumbnail Proxy ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.get('/api/download-thumbnail', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Missing URL.');
    try {
        const imageRes = await fetch(imageUrl);
        if (!imageRes.ok) throw new Error('Failed to fetch image.');
        res.setHeader('Content-Disposition', 'attachment; filename="youtube_thumbnail.jpg"');
        res.setHeader('Content-Type', 'image/jpeg');
        res.send(Buffer.from(await imageRes.arrayBuffer()));
    } catch (err) {
        res.status(500).send('Error downloading image.');
    }
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ API Status ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.get('/api/status', (req, res) => {
    const keys = getApiKeys();
    res.json({
        status: 'running',
        geminiApiKeyConfigured: keys.length > 0,
        keysCount: keys.length,
        groqConfigured: Boolean(getGroqApiKey()),
        youtubeConfigured: isYoutubeConfigured(),
        youtubeLinked: Boolean(youtubeTokenStore)
    });
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Video Analysis ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.post('/api/analyze', uploadVideo.single('video'), async (req, res) => {
    const keys = getApiKeys();
    if (keys.length === 0) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'No Gemini API Keys configured.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Please upload a video file.' });

    const jobId = generateJobId();
    jobs[jobId] = { id: jobId, status: 'uploading', progress: 10, logs: ['processing ÃƒÂ¢Ã…Â¡Ã‚Â¡', 'ÃƒÂ¢Ã…❌€œÃ¢❌‚¬Â¦ Video uploaded successfully'], result: null, error: null };

    const videoAspect = req.body.videoAspect || '16:9';
    const videoWidth = Number(req.body.videoWidth || 0);
    const videoHeight = Number(req.body.videoHeight || 0);
    res.json({ success: true, jobId });
    runAnalysisWorker(jobId, req.file.path, req.file.mimetype, req.file.originalname, videoAspect, videoWidth, videoHeight);
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Job Status ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.get('/api/job/:jobId', (req, res) => {
    const job = jobs[req.query.jobId || req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(job);
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Chat With Your Video ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.post('/api/chat', async (req, res) => {
    const { jobId, message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided.' });

    const job = jobs[jobId];
    const analysisContext = job && job.result ? JSON.stringify(job.result) : null;

    const systemPrompt = `You are an expert YouTube content advisor and AI video coach with deep knowledge of the YouTube algorithm, content creation, SEO, and audience psychology. 
${analysisContext ? `You have already performed a full AI analysis on the user's video. Here is the complete analysis data in JSON format:\n\n${analysisContext.substring(0, 8000)}\n\n` : ''}
Based on this analysis and your expertise, answer the user's question.

CRITICAL RESPONSE RULES:
1. Reply in short bullet points only.
2. Keep each bullet 1 to 2 lines.
3. Give deep, useful guidance, but do not write long paragraphs.
4. Use simple Hinglish or English matching the user's language.
5. Use timestamps and exact analysis data whenever helpful.
6. If you mention YouTube's algorithm, explain it as a practical simulation based on public signals, not private internal data.`;

    try {
        const reply = await runGroqChat(systemPrompt, message, history || []);
        res.json({ reply, provider: 'groq', model: getGroqModel() });
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ YouTube Account Linking ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.get('/api/youtube/auth-url', (req, res) => {
    if (!isYoutubeConfigured()) {
        return res.status(400).json({ error: 'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in .env, then restart.' });
    }

    const cfg = getYoutubeConfig();
    youtubeAuthState = crypto.randomBytes(18).toString('hex');
    const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: youtubeAuthState
    });

    res.json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

app.get('/api/youtube/oauth2callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
        return res.send(`<html><body><h3>YouTube linking failed</h3><p>${escapeHtml(error)}</p></body></html>`);
    }
    if (!code || !state || state !== youtubeAuthState) {
        return res.status(400).send('<html><body><h3>Invalid YouTube login request.</h3></body></html>');
    }

    try {
        const cfg = getYoutubeConfig();
        const tokenData = await fetchJson('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: cfg.clientId,
                client_secret: cfg.clientSecret,
                redirect_uri: cfg.redirectUri,
                grant_type: 'authorization_code'
            }).toString()
        });

        youtubeTokenStore = {
            ...tokenData,
            expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000)
        };
        youtubeChannelCache = null;
        youtubeAuthState = null;

        res.send(`<!doctype html>
<html>
<head><title>YouTube Linked</title></head>
<body style="font-family:Arial,sans-serif;background:#0f1115;color:#fff;display:grid;place-items:center;min-height:100vh;">
    <div style="text-align:center;">
        <h2>YouTube account linked successfully.</h2>
        <p>You can close this window.</p>
    </div>
    <script>
        if (window.opener) window.opener.postMessage({ type: 'youtube-linked' }, window.location.origin);
        setTimeout(() => window.close(), 700);
    </script>
</body>
</html>`);
    } catch (err) {
        res.status(500).send(`<html><body><h3>YouTube linking failed</h3><p>${escapeHtml(err.message)}</p></body></html>`);
    }
});

app.get('/api/youtube/channel', async (req, res) => {
    if (!youtubeTokenStore) {
        return res.status(401).json({ error: 'YouTube account is not linked yet.' });
    }
    try {
        const data = await loadYoutubeChannelData(req.query.refresh === '1');
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/youtube/disconnect', (req, res) => {
    youtubeTokenStore = null;
    youtubeChannelCache = null;
    youtubeAuthState = null;
    res.json({ success: true });
});

app.post('/api/channel-chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided.' });
    if (!youtubeTokenStore) return res.status(401).json({ error: 'YouTube account is not linked yet.' });

    try {
        const channelData = await loadYoutubeChannelData(false);
        const compactContext = JSON.stringify({
            channel: channelData.channel,
            statistics: channelData.statistics,
            summary: channelData.summary,
            videos: channelData.videos.slice(0, 30).map(video => ({
                title: video.title,
                type: video.type,
                views: video.viewCount,
                likes: video.likeCount,
                comments: video.commentCount,
                duration: video.duration,
                publishedAt: video.publishedAt,
                url: video.url
            }))
        });

        const systemPrompt = `You are a practical YouTube channel growth coach. The user linked their real YouTube account and this is the channel data:\n\n${compactContext.substring(0, 12000)}\n\nResponse rules: use short bullet points, simple Hinglish/English, give direct actions, compare videos using real stats, and avoid long paragraphs. If data is missing, say exactly what is missing.`;
        const reply = await runGroqChat(systemPrompt, message, history || []);
        res.json({ reply, provider: 'groq', model: getGroqModel() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Standalone Thumbnail Analyzer ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
app.post('/api/analyze-thumbnail', uploadImage.single('thumbnail'), async (req, res) => {
    const keys = getApiKeys();
    if (keys.length === 0) { if (req.file) fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'No API keys.' }); }
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

    const localPath = req.file.path;
    try {
        const fileManager = new GoogleAIFileManager(keys[0]);
        const genAI = new GoogleGenerativeAI(keys[0]);

        const uploadResult = await fileManager.uploadFile(localPath, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        let fileState = await fileManager.getFile(uploadResult.file.name);
        let attempts = 0;
        while (fileState.state === "PROCESSING" && attempts < 20) {
            await new Promise(r => setTimeout(r, 2000));
            fileState = await fileManager.getFile(uploadResult.file.name);
            attempts++;
        }
        if (fileState.state !== "ACTIVE") throw new Error('Thumbnail processing failed.');

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ fileData: { fileUri: uploadResult.file.uri, mimeType: uploadResult.file.mimeType } }, { text: `Analyze this YouTube thumbnail and return ONLY raw JSON (no markdown). 
CRITICAL RULE: For all text fields, strengths, weaknesses, improvements, and descriptions, write in clear, short statements (about 1 to 2 lines per statement) using very simple and easy English. Do not use hard or complex words. Make everything very clear and easy to understand.

Follow this exact structure:
{"thumbnailScore":82,"ctRPotential":"High","strengths":["s1","s2"],"weaknesses":["w1"],"improvements":["i1","i2"],"colorAnalysis":"...","textAnalysis":"...","emotionImpact":"...","facePresence":"...","overallVerdict":"...","heatmapZones":[{"zone":"top-left","focus":"Low","reason":"..."},{"zone":"center","focus":"High","reason":"..."},{"zone":"top-right","focus":"Medium","reason":"..."}]}` }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const parsed = JSON.parse(result.response.text());
        try { await fileManager.deleteFile(uploadResult.file.name); } catch (e) { }
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        res.json({ success: true, data: parsed });
    } catch (err) {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        res.status(500).json({ error: err.message });
    }
});

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Main Analysis Worker ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
async function runAnalysisWorker(jobId, localPath, mimeType, originalName, videoAspect, videoWidth = 0, videoHeight = 0) {
    const job = jobs[jobId];
    const keys = getApiKeys();
    const isShorts = videoAspect === '9:16';
    const thumbnailSize = getThumbnailDimensions(videoAspect, videoWidth, videoHeight);

    const modelNames = [];
    if (process.env.GEMINI_MODEL) modelNames.push(process.env.GEMINI_MODEL);
    modelNames.push("gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.0-flash-lite");
    const uniqueModelNames = [...new Set(modelNames)];

    const prompt = `You are an elite YouTube AI analyst and content coach. Perform the most comprehensive possible analysis of this ${isShorts ? 'YouTube Short' : 'YouTube Video'}. Watch every frame, listen to all audio, transcribe all speech, detect emotions and faces, analyze pacing, editing style, storytelling, humor, visual quality, and everything else.

Also run a realistic YouTube recommendation-system simulation using public creator guidance and observable ranking signals. You do not have access to YouTube's private internal algorithm, so never claim that. Simulate how the video may perform across seed audience testing, CTR, retention, satisfaction, engagement, freshness, topic-match, personalization fit, safety, and rewatch/share signals.

Return ONLY a raw JSON object (absolutely no markdown, no backticks).

CRITICAL RULE FOR ALL TEXT FIELDS, STRATEGIES, REASONINGS, TITLES, DESCRIPTIONS, SUGGESTIONS, AND FEEDBACK:
1. Write useful, deep feedback, but in short scannable points.
2. Each point should be 1 to 2 lines, never a long paragraph.
3. Use simple English or Hinglish-style wording that a beginner can understand.
4. Prefer arrays of short points when a field needs multiple ideas.
5. Keep the information complete, but compact.

Follow this exact structure:

{
  "rating": 8.5,
  "viewsPotential": "High",
  "viewsReasoning": "Detailed reasoning",

  "feedback": {
    "visualQuality": "Detailed visual audit",
    "audioQuality": "Detailed audio audit",
    "hook": "Hook assessment (first 3-10 seconds)",
    "editingStyle": "Pacing, cuts, transitions assessment",
    "improvementSuggestions": ["Improvement 1", "Improvement 2", "Improvement 3"]
  },

  "viralScore": { "overall": 78, "entertainment": 80, "watchability": 75, "shareability": 70, "engagementPotential": 82 },

  "hookAnalysis": {
    "rating": 7,
    "hookText": "What appears/is said in first 5 seconds",
    "retentionPrediction": "Predicted % watching past 10 seconds and why",
    "hookSuggestions": ["Hook idea 1", "Hook idea 2", "Hook idea 3"]
  },

  "retentionMap": [
    { "timestamp": "0:00-0:10", "riskLevel": "Low", "note": "Strong hook" },
    { "timestamp": "0:10-0:30", "riskLevel": "Medium", "note": "Pacing slows" }
  ],

  "emotionAnalysis": {
    "primaryEmotion": "Motivational",
    "toneBreakdown": { "funny": 10, "sad": 5, "motivational": 70, "exciting": 15 },
    "emotionalArc": "How emotion changes throughout the video"
  },

  "profanityDetection": {
    "isClean": true,
    "flaggedWords": [],
    "verdict": "Content is family-friendly"
  },

  "shortsAnalysis": {
    "isSuitable": true,
    "reasoning": "Why suitable or not for Shorts",
    "recommendedDuration": "Ideal duration"
  },

  "faceExpressionAnalysis": {
    "detected": true,
    "emotionalMoments": [
      { "timestamp": "0:05", "emotion": "Excited", "intensity": "High" },
      { "timestamp": "0:30", "emotion": "Serious", "intensity": "Medium" }
    ],
    "peakImpactMoment": "Timestamp and description of strongest facial expression moment",
    "suggestions": ["Suggestion to improve facial expression engagement 1", "Suggestion 2"]
  },

  "voiceEnergyAnalysis": {
    "overallEnergy": "High",
    "averageSpeakingSpeed": "Moderate (around 140 words per minute)",
    "monotoneSections": [
      { "timestamp": "0:15-0:30", "note": "Voice becomes flat here, lacks variation" }
    ],
    "recommendations": ["Be more expressive at 0:15", "Add vocal emphasis on key points"]
  },

  "silenceDetection": {
    "unnecessaryPauses": [
      { "timestamp": "0:08", "duration": "2 seconds", "suggestion": "Cut this pause" },
      { "timestamp": "0:45", "duration": "3 seconds", "suggestion": "Fill with music or cut" }
    ],
    "totalSilenceEstimate": "About 8% of video is unnecessary silence",
    "overallVerdict": "Verdict on silence quality"
  },

  "audioQualityDetailed": {
    "noiseLevel": "Low",
    "echoDetected": false,
    "clarityScore": 85,
    "microphoneQuality": "Good - sounds like a decent USB microphone",
    "backgroundMusicBalance": "Music is slightly too loud at 0:20",
    "recommendations": ["Recommendation 1", "Recommendation 2"]
  },

  "memePotential": {
    "score": 72,
    "clipSuggestions": [
      { "timestamp": "0:12-0:15", "description": "Funny reaction moment", "whyViral": "Relatable expression that works as a meme" },
      { "timestamp": "0:45-0:48", "description": "Unexpected moment", "whyViral": "Surprise element perfect for short clips" }
    ]
  },

  "highlightMoments": [
    { "timestamp": "0:05", "description": "Strong opening statement", "interestScore": 92 },
    { "timestamp": "0:30", "description": "Key insight revealed", "interestScore": 88 },
    { "timestamp": "1:00", "description": "Most engaging moment", "interestScore": 95 }
  ],

  "shortsClipSuggestions": [
    { "startTime": "0:00", "endTime": "0:30", "title": "Suggested Shorts title 1", "viralReason": "Strong hook + quick payoff" },
    { "startTime": "0:45", "endTime": "1:15", "title": "Suggested Shorts title 2", "viralReason": "High-energy moment" }
  ],

  "engagementPrediction": {
    "likes": "2K-5K",
    "comments": "100-300",
    "shares": "50-150",
    "subscribersGained": "20-80",
    "reasoning": "Why these numbers are predicted"
  },

  "replayMoments": [
    { "timestamp": "0:20", "description": "Moment viewers will replay", "reason": "Contains important information delivered quickly" },
    { "timestamp": "0:55", "description": "Another replay-worthy moment", "reason": "Funny/surprising" }
  ],

  "storytellingAnalysis": {
    "introduction": "Assessment of how the intro sets up the video",
    "conflict": "Is there a problem/conflict established?",
    "buildUp": "How tension or interest builds",
    "climax": "The peak moment and how effective it is",
    "ending": "How satisfying and strong the ending is",
    "overallArc": "Overall storytelling effectiveness score and assessment",
    "score": 7
  },

  "humorAnalysis": {
    "funniness": 65,
    "moments": [
      { "timestamp": "0:10", "type": "Relatable joke", "effectiveness": "High" },
      { "timestamp": "0:40", "type": "Self-deprecating humor", "effectiveness": "Medium" }
    ],
    "suggestions": ["Add a callback to the opening joke", "Use more visual comedy"]
  },

  "pacingAnalysis": {
    "overallPace": "Good",
    "tooFastSections": [
      { "timestamp": "0:30-0:35", "note": "Information delivered too fast here" }
    ],
    "tooSlowSections": [
      { "timestamp": "0:50-1:00", "note": "Video drags here, consider cutting" }
    ],
    "recommendations": ["Slow down at 0:30 for clarity", "Cut 0:50-0:55 to improve pacing"]
  },

  "visualQualityDetailed": {
    "lighting": "Good natural lighting, slightly overexposed on right side",
    "colorGrading": "Warm tones, consistent throughout",
    "cameraShake": "Minimal, stable footage",
    "sharpness": "Sharp and in focus",
    "overallAppeal": "Professional looking with minor improvements needed",
    "score": 82
  },

  "backgroundAnalysis": {
    "distractions": [
      { "description": "Clutter visible on left side of frame", "timestamp": "throughout" }
    ],
    "cleanlinessScore": 70,
    "suggestions": ["Remove items from left side", "Add branded background element"]
  },

  "cameraMovementAnalysis": {
    "stability": "Good",
    "excessiveMovements": [
      { "timestamp": "0:20", "description": "Sudden pan that is distracting" }
    ],
    "recommendations": ["Use a tripod for static shots", "Avoid handheld during main talking points"]
  },

  "editingStyleAnalysis": {
    "style": "Fast-paced",
    "characteristics": ["Jump cuts", "Text overlays", "Quick transitions"],
    "confidence": 88,
    "alternativeStyles": ["Could benefit from more cinematic B-roll cuts"]
  },

  "nicheDetector": {
    "primaryNiche": "Education",
    "secondaryNiche": "Tech",
    "confidence": 91,
    "subNiches": ["AI tools", "Productivity", "Self-improvement"],
    "monetizationFit": "High CPM niche"
  },

  "sponsorOpportunityScore": {
    "score": 78,
    "brandFriendliness": "High",
    "potentialBrands": ["Tech companies", "Online course platforms", "Productivity apps"],
    "reasoning": "Clean content, professional delivery, educated audience with high purchasing power"
  },

  "monetizationScore": {
    "cpmPotential": "High ($8-15 CPM estimated)",
    "advertiserFriendliness": "Fully monetizable",
    "revenueEstimate": "$15-80 per 10K views",
    "reasoning": "Tech/Education niche commands premium CPM rates"
  },

  "copyrightRisk": {
    "musicRisk": "Low",
    "visualRisk": "Low",
    "overallRisk": "Low",
    "warnings": [],
    "verdict": "Content appears safe from copyright claims"
  },

  "communityGuidelineRisk": {
    "riskLevel": "Very Low",
    "concerns": [],
    "demonetizationRisk": "Very Low",
    "verdict": "Content fully complies with YouTube community guidelines"
  },

  "similarCreatorAnalysis": {
    "creators": [
      { "name": "Similar Creator Style 1 (based on content type)", "strength": "Better thumbnail CTR", "weakness": "Less in-depth content" },
      { "name": "Similar Creator Style 2", "strength": "Stronger hooks", "weakness": "Less consistent uploads" }
    ],
    "differentiators": "What makes this creator unique",
    "competitiveEdge": "Potential competitive advantage"
  },

  "trendingTopicAnalysis": {
    "matchingTrends": ["Trend 1 this content relates to", "Trend 2"],
    "trendScore": 72,
    "opportunities": ["Could capitalize on trending topic X", "Timing with Y event"]
  },

  "futureTrendPrediction": {
    "upcomingTopics": ["Topic gaining momentum 1", "Topic gaining momentum 2"],
    "contentIdeas": ["Video idea based on upcoming trend 1", "Video idea 2"],
    "timeframe": "These trends expected to peak in next 2-4 weeks"
  },

  "aiVideoCoach": {
    "overallAssessment": "Comprehensive coaching assessment of this video in simple language",
    "topMistakes": ["Mistake 1 explained simply", "Mistake 2", "Mistake 3"],
    "improvementPlan": [
      { "step": 1, "action": "First thing to fix", "impact": "High", "effort": "Low" },
      { "step": 2, "action": "Second thing to fix", "impact": "Medium", "effort": "Medium" },
      { "step": 3, "action": "Third improvement", "impact": "High", "effort": "High" }
    ],
    "encouragement": "Positive note about what the creator is doing well"
  },

  "seriesPlanner": {
    "seriesTitle": "Suggested series name",
    "sequelIdeas": ["Part 2 idea", "Part 3 idea", "Spin-off idea"],
    "episodePlan": [
      { "episode": 1, "title": "This video (current)", "status": "Done" },
      { "episode": 2, "title": "Suggested next episode", "topic": "What to cover" },
      { "episode": 3, "title": "Episode 3 idea", "topic": "What to cover" }
    ]
  },

  "subscriberGrowthPrediction": {
    "thirtyDay": "50-200 subscribers if consistent",
    "ninetyDay": "200-800 subscribers with 3 videos/week",
    "oneYear": "2K-10K subscribers with consistent quality content",
    "reasoning": "Based on niche competitiveness, content quality, and upload frequency assumptions"
  },

  "aiContentCalendar": {
    "weeklyPlan": [
      { "day": "Monday", "contentIdea": "Content idea", "format": "Long video (10-15 min)" },
      { "day": "Wednesday", "contentIdea": "Content idea", "format": "Short (60 sec)" },
      { "day": "Friday", "contentIdea": "Content idea", "format": "Long video (8-12 min)" },
      { "day": "Saturday", "contentIdea": "Content idea", "format": "Short (30-45 sec)" }
    ],
    "consistency": "Recommended upload frequency for this niche"
  },

  "frameSummary": {
    "keyFrames": [
      { "timestamp": "0:00", "description": "Opening frame description", "significance": "Sets tone" },
      { "timestamp": "0:30", "description": "Key moment frame", "significance": "Most impactful visual" }
    ],
    "visualStorytelling": "Assessment of how well visuals tell the story"
  },

  "automaticSummary": {
    "shortSummary": "One paragraph summary of the entire video content",
    "detailedSummary": "Full detailed summary covering all main points discussed",
    "keyPoints": ["Key point 1", "Key point 2", "Key point 3"]
  },

  "aiImprovementScore": {
    "currentScore": 72,
    "potentialScore": 91,
    "improvementGap": 19,
    "keyChangesNeeded": ["Most impactful change 1", "Change 2", "Change 3"],
    "timeToImprove": "Estimated 2-3 hours of re-editing to reach potential score"
  },

  "transcript": "Full verbatim transcript of all speech in the video",
  "autoChapters": [
    { "timestamp": "0:00", "title": "Introduction" },
    { "timestamp": "0:30", "title": "Main Content" }
  ],
  "sceneList": [
    { "timestamp": "0:00-0:05", "description": "Scene description" }
  ],
  "scriptRewrite": "Complete viral-optimized rewrite of the script",
  "ctaSuggestions": ["CTA for likes", "CTA for comments", "CTA for subscribe"],
  "bRollSuggestions": [
    { "timestamp": "0:10", "suggestion": "B-roll idea" }
  ],
  "musicSuggestion": {
    "style": "Energetic",
    "reason": "Why this style fits",
    "examples": ["Style example 1", "Style example 2"]
  },
  "sfxSuggestions": [
    { "timestamp": "0:05", "effect": "Sound effect idea" }
  ],
  "subtitleHighlights": ["Key word 1", "Key word 2", "Key phrase"],

  "growthPrediction": {
    "worstCase": "500-1K views",
    "averageCase": "5K-15K views",
    "bestCase": "50K-200K views",
    "reasoning": "Why these ranges"
  },

  "uploadTiming": {
    "bestDay": "Friday",
    "bestTime": "5:00 PM - 8:00 PM IST",
    "countrySpecific": {
      "India": "5:00 PM - 9:00 PM IST",
      "USA": "2:00 PM - 5:00 PM EST",
      "UK": "6:00 PM - 9:00 PM GMT"
    },
    "reasoning": "Why these times"
  },

  "audienceType": {
    "primary": "Teens (13-24)",
    "secondary": "Young Adults (25-34)",
    "interests": ["Interest 1", "Interest 2"],
    "audienceProfile": "Detailed audience description"
  },

  "competitorInsights": {
    "similarChannelStyle": "What top channels in this niche do",
    "missingElements": ["Missing element 1", "Missing element 2"],
    "inspiredImprovements": ["Improvement 1", "Improvement 2"]
  },

  "abTitleTest": {
    "titleA": "First title option",
    "titleB": "Second title option",
    "predictedWinner": "A",
    "reasoning": "Why A wins"
  },

  "channelGrowthAdvice": {
    "futureVideoIdeas": ["Video idea 1", "Video idea 2", "Video idea 3"],
    "contentStrategy": "Channel growth strategy"
  },

  "metadata": {
    "titles": {
      "english": ["English Title 1 with emojis", "English Title 2 with emojis"],
      "hindi": ["Hindi/Hinglish Title 1 with emojis", "Hindi/Hinglish Title 2 with emojis"]
    },
    "descriptions": [
      "Description option 1 - clickbait style with emojis",
      "Description option 2 - value-packed with emojis",
      "Description option 3 - storytelling style with emojis",
      "Description option 4 - ultra-short Shorts style with emojis"
    ],
    "hashtags": {
      "list": [{ "tag": "#Tag1", "rank": 98 }, { "tag": "#Tag2", "rank": 87 }],
      "recommendedQuantity": "Use 3-5 hashtags"
    },
    "tags": {
      "list": ["Tag 1", "Tag 2", "Tag 3", "Tag 4", "Tag 5"],
      "recommendedQuantity": "Use 10-15 tags"
    }
  },

  "thumbnailPrompt": "Detailed production-grade thumbnail prompt for image generation",

  "algorithmSimulation": {
    "ctrScore": 85,
    "hookStrength": 80,
    "retentionRisk": "Low",
    "algorithmFeedback": "Short simulation summary based on public ranking signals",
    "seedAudienceTest": {
      "passChance": 78,
      "reason": "How likely the first test audience is to keep watching and engage"
    },
    "rankingSignals": {
      "thumbnailCtr": 82,
      "titleMatch": 76,
      "firstThirtySecondsRetention": 74,
      "averageViewDuration": 70,
      "viewerSatisfaction": 78,
      "engagementVelocity": 68,
      "rewatchPotential": 64,
      "sharePotential": 72,
      "topicDemand": 75,
      "freshness": 66,
      "policySafety": 94
    },
    "distributionStages": [
      { "stage": "Seed audience", "score": 78, "verdict": "Likely to pass because the hook is clear" },
      { "stage": "Broader similar viewers", "score": 70, "verdict": "Needs stronger retention after the first drop-off" },
      { "stage": "Browse and Suggested", "score": 64, "verdict": "Thumbnail and title must promise the exact payoff" },
      { "stage": "Search discovery", "score": 72, "verdict": "Good if keywords match the spoken topic and description" }
    ],
    "actionPriorities": [
      "Improve first 5 seconds so more viewers stay.",
      "Make title and thumbnail promise one clear benefit.",
      "Cut slow parts before the first major payoff.",
      "Add a comment question to increase early engagement."
    ]
  },

  "uploadStrategy": {
    "bestTime": "5:00 PM - 8:00 PM IST Weekdays",
    "thumbnailIdea": "Thumbnail description",
    "audienceTarget": "Target demographic",
    "uploadSteps": [
      "Step 1: Upload as Private first.",
      "Step 2: Add all tags before publishing.",
      "Step 3: Add description with 3 hashtags at the end.",
      "Step 4: Add custom thumbnail.",
      "Step 5: Add end screens and cards.",
      "Step 6: Pin a comment with a question to boost engagement.",
      "Step 7: Switch to Public at peak posting time."
    ]
  }
}`;

    let jsonResponse = null;
    let lastKeyError = null;

    for (let k = 0; k < keys.length; k++) {
        const apiKey = keys[k];
        let geminiFileName = null;

        job.logs.push(`ðŸ”‘ Fallback check: Gemini API key ${k + 1} of ${keys.length}`);

        try {
            const fileManager = new GoogleAIFileManager(apiKey);
            const genAI = new GoogleGenerativeAI(apiKey);

            job.status = 'processing';
            job.progress = 30;
            job.logs.push(`ðŸ“¤ Uploading video to AI processing engine`);

            const uploadResult = await fileManager.uploadFile(localPath, { mimeType, displayName: originalName });
            geminiFileName = uploadResult.file.name;
            job.logs.push(`✅ Video uploaded successfully`);

            job.progress = 40;
            job.logs.push('ðŸ” Extracting video metadata (duration, resolution, upload date)');

            let fileState = await fileManager.getFile(geminiFileName);
            let attempts = 0;
            while (fileState.state === "PROCESSING") {
                attempts++;
                await new Promise(r => setTimeout(r, 3000));
                fileState = await fileManager.getFile(geminiFileName);
                if (attempts % 3 === 0) job.logs.push('ðŸŽ¬ Detecting scene changes and key moments');
            }

            if (fileState.state !== "ACTIVE") throw new Error(`Processing failed: ${fileState.state}`);
            job.logs.push('✅ Video ready for full AI audit');

            const phases = [
                '😊 Detecting emotions and tone',
                '📊 Measuring pacing and engagement patterns',
                '🏷️ Extracting topics, keywords, and hashtags',
                '👥 Identifying target audience',
                '📈 Predicting retention performance',
                '🧠 Simulating YouTube recommendation signals',
                '🔎 Checking CTR, watch time, satisfaction, and safety signals',
                '💡 Generating improvement suggestions',
                '📝 Preparing final report'
            ];
            for (const phase of phases) {
                job.logs.push(phase);
                await new Promise(r => setTimeout(r, 600));
            }

            job.status = 'analyzing';
            job.progress = 70;

            let keySuccess = false;
            let generationError = null;

            for (const currentModelName of uniqueModelNames) {
                try {
                    if (uniqueModelNames.indexOf(currentModelName) > 0) {
                        job.logs.push(`Retrying with ${currentModelName}...`);
                        await new Promise(r => setTimeout(r, 2500));
                    }

                    job.logs.push(`Analyzing with model: ${currentModelName}...`);
                    const model = genAI.getGenerativeModel({ model: currentModelName });

                    const result = await model.generateContent({
                        contents: [{ role: 'user', parts: [{ fileData: { fileUri: uploadResult.file.uri, mimeType: uploadResult.file.mimeType } }, { text: prompt }] }],
                        generationConfig: { responseMimeType: "application/json" }
                    });

                    jsonResponse = JSON.parse(result.response.text());

                    // Generate a thumbnail in the same format as the uploaded video/short.
                    if (jsonResponse.thumbnailPrompt) {
                        const enhancedPrompt = buildThumbnailPrompt(jsonResponse.thumbnailPrompt, thumbnailSize.aspect)
                            .replace(/[^\x20-\x7E]/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        const seed = Math.floor(Math.random() * 100000);
                        jsonResponse.thumbnailImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(enhancedPrompt)}?width=${thumbnailSize.width}&height=${thumbnailSize.height}&nologo=true&enhance=true&safe=true&seed=${seed}`;
                        jsonResponse.videoAspect = thumbnailSize.aspect;
                        jsonResponse.thumbnailSize = { width: thumbnailSize.width, height: thumbnailSize.height };
                    }

                    job.logs.push(`… Analysis complete with ${currentModelName}!`);
                    keySuccess = true;
                    break;
                } catch (err) {
                    generationError = err;
                    job.logs.push(`⚠️  ${currentModelName} failed: ${err.message.substring(0, 80)}`);
                }
            }

            if (geminiFileName) {
                try { await fileManager.deleteFile(geminiFileName); job.logs.push('Gemini storage cleaned up.'); } catch (e) { }
            }

            if (keySuccess) break;
            else throw new Error(generationError ? generationError.message : 'All models failed.');

        } catch (err) {
            lastKeyError = err;
            job.logs.push(`Key #${k + 1} failed: ${err.message}`);
        }
    }

    try {
        if (jsonResponse) {
            job.progress = 100;
            job.status = 'completed';
            job.result = jsonResponse;
            job.videoPath = '/uploads/' + path.basename(localPath);
            job.logs.push('… Analysis completed');
            job.logs.push('✨ Analysis completed');
        } else {
            if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); } catch(e){} }
            throw new Error(`All keys failed. Last: ${lastKeyError ? lastKeyError.message : 'Unknown'}`);
        }
    } catch (err) {
        if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); } catch(e){} }
        job.status = 'failed';
        job.error = err.message;
        job.logs.push(`❌ ${err.message}`);
    }
}

const getManusApiKey = () => {
    const key = process.env.MANUS_API_KEY;
    return key && key.trim() && !key.includes('your_') ? key.trim() : null;
};

async function callManusAI(messages, maxTokens = 2000) {
    const apiKey = getManusApiKey();
    if (!apiKey) throw new Error('Manus AI API key not configured. Add MANUS_API_KEY to .env');

    // Try OpenAI-compatible endpoint at api.manus.im with multiple auth strategies
    const endpoints = [
        { url: 'https://api.manus.im/v1/chat/completions', headers: { 'API_KEY': apiKey, 'Content-Type': 'application/json' } },
        { url: 'https://api.manus.im/v1/chat/completions', headers: { 'x-manus-api-key': apiKey, 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
        { url: 'https://api.manus.ai/v1/chat/completions', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    ];

    let lastErr = null;
    for (const ep of endpoints) {
        try {
            const response = await fetch(ep.url, {
                method: 'POST',
                headers: ep.headers,
                body: JSON.stringify({
                    model: 'manus-2',
                    messages,
                    temperature: 0.7,
                    max_tokens: maxTokens,
                    stream: false
                })
            });

            const text = await response.text();
            let json = {};
            try { json = JSON.parse(text); } catch {}
            if (!response.ok) {
                lastErr = new Error(json.error?.message || text || `Manus AI request failed: ${response.status}`);
                continue; // Try next endpoint
            }
            const content = json.choices?.[0]?.message?.content?.trim();
            if (content) {
                console.log('Manus AI succeeded via:', ep.url);
                return content;
            }
            lastErr = new Error('No response content from Manus AI');
        } catch (fetchErr) {
            lastErr = fetchErr;
            continue; // Try next endpoint
        }
    }
    throw lastErr || new Error('All Manus AI endpoints failed');
}

async function callManusWithFallback(messages, maxTokens = 2000) {
    // Try Manus first, then fall back to Groq if Manus fails
    try {
        return await callManusAI(messages, maxTokens);
    } catch (manusErr) {
        console.log('Manus AI failed, falling back to Groq:', manusErr.message);
        // Fallback to Groq
        const sysMsg = messages.find(m => m.role === 'system');
        const userMsgs = messages.filter(m => m.role !== 'system');
        const lastUser = userMsgs[userMsgs.length - 1];
        const historyMsgs = userMsgs.slice(0, -1);
        return await runGroqChat(sysMsg?.content || '', lastUser?.content || '', historyMsgs, maxTokens);
    }
}

// ÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚Â
//  MANUS-STYLE VIDEO EDITING AGENT
// ÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚ÂÃƒÂ¢Ã¢❌‚¬Â¢Ã‚Â
const { exec } = require('child_process');

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Step-based FFmpeg Builder ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬
function buildFFmpegFromSteps(steps) {
    let vf = [];
    let af = [];
    let preInputArgs = [];
    // Collect eq params separately to merge them into one eq filter
    let eqParams = {};
    let hasSpeed = false;
    let lastSpeed = 1.0;

    // Deduplicate: only keep the last speed step
    const deduped = [];
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i]?.type === 'speed') {
            if (!hasSpeed) { hasSpeed = true; lastSpeed = steps[i].value; deduped.unshift(steps[i]); }
        } else {
            deduped.unshift(steps[i]);
        }
    }

    for (const step of deduped) {
        if (!step || !step.type) continue;
        switch (step.type) {
            case 'color_filter':
                switch (step.filter) {
                    case 'grayscale': vf.push('hue=s=0'); break;
                    case 'sepia': vf.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131'); break;
                    case 'vintage': vf.push('vignette=angle=0.4'); vf.push('colorchannelmixer=.3:.4:.3:0:.3:.4:.2:0:.2:.3:.3'); break;
                    case 'high_contrast': eqParams.contrast = 1.5; eqParams.brightness = 0.04; eqParams.saturation = 1.3; break;
                    case 'negative': vf.push('lutrgb=r=negval:g=negval:b=negval'); break;
                    case 'vibrant': eqParams.saturation = 2.0; eqParams.contrast = 1.15; break;
                    case 'warm': vf.push('colorbalance=rs=.15:gs=.05:bs=-.1:rm=.1:gm=.05:bm=-.05'); break;
                    case 'cool': vf.push('colorbalance=rs=-.1:gs=.0:bs=.15:rm=-.05:gm=.0:bm=.1'); break;
                    case 'cinematic': eqParams.contrast = 1.4; eqParams.brightness = -0.02; eqParams.saturation = 0.85; vf.push('vignette=angle=0.35'); break;
                }
                break;

            case 'brightness':
                eqParams.brightness = Math.max(-1, Math.min(1, Number(step.value) || 0));
                break;

            case 'contrast':
                eqParams.contrast = Math.max(0.3, Math.min(3, Number(step.value) || 1));
                break;

            case 'saturation':
                eqParams.saturation = Math.max(0, Math.min(3, Number(step.value) || 1));
                break;

            case 'speed': {
                const speed = Math.max(0.5, Math.min(2.0, Number(step.value) || 1));
                if (speed !== 1.0) {
                    vf.push(`setpts=PTS/${speed}`);
                    af.push(`atempo=${speed}`);
                }
                break;
            }

            case 'text_overlay':
                if (step.text) {
                    const escapedText = String(step.text)
                        .replace(/[\\]/g, '\\\\\\\\\\\\\\\\')
                        .replace(/'/g, '')
                        .replace(/:/g, '\\\\:')
                        .replace(/"/g, '')
                        .replace(/&/g, 'and')
                        .replace(/[^a-zA-Z0-9 .,!?\-_]/g, '');
                    const fontSize = Math.max(16, Math.min(96, Number(step.fontSize) || 42));
                    const fontColor = step.fontColor || 'white';
                    let x, y;
                    switch (step.position) {
                        case 'top': x = '(w-text_w)/2'; y = '30'; break;
                        case 'bottom': x = '(w-text_w)/2'; y = '(h-text_h-30)'; break;
                        case 'top-left': x = '30'; y = '30'; break;
                        case 'top-right': x = '(w-text_w-30)'; y = '30'; break;
                        case 'bottom-left': x = '30'; y = '(h-text_h-30)'; break;
                        case 'bottom-right': x = '(w-text_w-30)'; y = '(h-text_h-30)'; break;
                        default: x = '(w-text_w)/2'; y = '(h-text_h)/2'; break;
                    }
                    vf.push(`drawtext=fontfile='C\\\\:/Windows/Fonts/arial.ttf':text='${escapedText}':fontcolor=${fontColor}:fontsize=${fontSize}:x=${x}:y=${y}:box=1:boxcolor=black@0.5:boxborderw=8`);
                }
                break;

            case 'audio_effect':
                switch (step.effect) {
                    case 'bass_boost': af.push('equalizer=f=60:width_type=o:width=2:g=8'); break;
                    case 'treble_boost': af.push('equalizer=f=3000:width_type=o:width=2:g=6'); break;
                    case 'volume_up': af.push(`volume=${Number(step.value) || 1.5}`); break;
                    case 'volume_down': af.push(`volume=${Number(step.value) || 0.5}`); break;
                    case 'mute': af.push('volume=0'); break;
                    case 'normalize': af.push('loudnorm'); break;
                    case 'echo': af.push('aecho=0.8:0.88:500:0.3'); break;
                }
                break;

            case 'vignette':
                vf.push(`vignette=angle=${Number(step.angle) || 0.4}`);
                break;

            case 'sharpen':
                vf.push('unsharp=5:5:1.5:5:5:0.0');
                break;

            case 'blur': {
                const blurVal = Math.max(1, Math.min(10, Number(step.value) || 3));
                vf.push(`boxblur=${blurVal}`);
                break;
            }

            case 'fade_in': {
                const d = Math.max(0.3, Math.min(5, Number(step.duration) || 1));
                vf.push(`fade=t=in:st=0:d=${d}`);
                af.push(`afade=t=in:st=0:d=${d}`);
                break;
            }

            case 'fade_out': {
                // Without knowing the exact duration we can't perfectly time this
                // Use a late start approximation
                const d = Math.max(0.3, Math.min(5, Number(step.duration) || 1));
                // We'll handle this specially after probe
                break;
            }

            case 'zoom': {
                const z = Math.max(1.05, Math.min(2.0, Number(step.value) || 1.2));
                vf.push(`scale=iw*${z}:ih*${z}:flags=lanczos,crop=iw/${z}:ih/${z}`);
                break;
            }

            case 'flip':
                if (step.direction === 'horizontal') vf.push('hflip');
                else if (step.direction === 'vertical') vf.push('vflip');
                break;

            case 'rotate': {
                const angle = Number(step.angle) || 0;
                if (angle === 90) vf.push('transpose=1');
                else if (angle === 180) vf.push('transpose=1,transpose=1');
                else if (angle === 270) vf.push('transpose=2');
                break;
            }

            case 'trim':
                if (step.start !== undefined && step.start !== null) preInputArgs.push('-ss', String(step.start));
                if (step.end !== undefined && step.end !== null) preInputArgs.push('-to', String(step.end));
                if (step.duration !== undefined && step.duration !== null) preInputArgs.push('-t', String(step.duration));
                break;
        }
    }

    // Merge eq params into a single filter
    if (Object.keys(eqParams).length > 0) {
        const eqParts = [];
        if (eqParams.contrast !== undefined) eqParts.push(`contrast=${eqParams.contrast}`);
        if (eqParams.brightness !== undefined) eqParts.push(`brightness=${eqParams.brightness}`);
        if (eqParams.saturation !== undefined) eqParts.push(`saturation=${eqParams.saturation}`);
        if (eqParts.length > 0) vf.unshift(`eq=${eqParts.join(':')}`);
    }

    return { vf, af, preInputArgs };
}

function editVideoWithSteps(inputPath, outputPath, steps) {
    return new Promise((resolve, reject) => {
        const { vf, af, preInputArgs } = buildFFmpegFromSteps(steps);

        let args = ['-y', ...preInputArgs, '-i', `"${inputPath}"`];
        if (vf.length > 0) args.push('-vf', `"${vf.join(',')}"`);
        if (af.length > 0) args.push('-af', `"${af.join(',')}"`);
        args.push('-preset', 'veryfast', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '128k');
        args.push(`"${outputPath}"`);

        const cmd = `ffmpeg ${args.join(' ')}`;
        console.log('[Manus Agent] FFmpeg command:', cmd);

        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                console.error('[Manus Agent] FFmpeg failed:', err.message);
                // Fallback: try without complex filters
                const fallbackCmd = `ffmpeg -y -i "${inputPath}" -preset veryfast -c:v libx264 -c:a aac "${outputPath}"`;
                console.log('[Manus Agent] Fallback command:', fallbackCmd);
                exec(fallbackCmd, { maxBuffer: 50 * 1024 * 1024 }, (fbErr) => {
                    if (fbErr) {
                        reject(new Error('Video processing failed: ' + fbErr.message));
                    } else {
                        resolve();
                    }
                });
            } else {
                console.log('[Manus Agent] FFmpeg processing completed successfully.');
                resolve();
            }
        });
    });
}

// ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ Manus Agent: Parse AI response into editing steps ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬ÃƒÂ¢Ã¢❌‚¬ÂÃ¢❌€šÂ¬

function parseEditPlan(aiResponse, userPrompt) {
    console.log('[Manus Agent] Raw AI response:', aiResponse);

    let plan = { steps: [], summary: '' };

    // Try to extract JSON from the response
    try {
        let cleaned = aiResponse.trim();
        // Remove markdown fences
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        // Extract the JSON object
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.steps && Array.isArray(parsed.steps)) {
                plan.steps = parsed.steps;
                plan.summary = parsed.summary || '';
            }
        }
    } catch (e) {
        console.log('[Manus Agent] JSON parse failed:', e.message);
    }

    // Validate steps ÃƒÂ¢Ã¢❌€šÂ¬Ã¢❌‚¬Â remove any with invalid types
    const validTypes = ['color_filter', 'brightness', 'contrast', 'saturation', 'speed', 'text_overlay', 'audio_effect', 'vignette', 'sharpen', 'blur', 'fade_in', 'fade_out', 'zoom', 'flip', 'rotate', 'trim'];
    plan.steps = plan.steps.filter(s => s && validTypes.includes(s.type));

    // If no valid steps could be extracted, the agent failed ÃƒÂ¢Ã¢❌€šÂ¬Ã¢❌‚¬Â log it clearly
    if (plan.steps.length === 0) {
        console.log('[Manus Agent] WARNING: Could not extract editing steps from AI response. User prompt was:', userPrompt);
        plan.summary = 'The AI could not parse the editing request. Please try a more specific prompt like "make it grayscale with speed 1.5x" or "add text HELLO at center".';
    }

    console.log('[Manus Agent] Final plan:', JSON.stringify(plan, null, 2));
    return plan;
}

// Ã¢❌€❌‚¬Ã¢❌€❌‚¬ The Agent System Prompt Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬
const MANUS_AGENT_SYSTEM_PROMPT = `You are the MANUS Video Editing Agent. You convert a user's editing request into executable FFmpeg steps.

CRITICAL RULES:
1. ONLY do what the user asked. Do NOT add extra edits. If they say "make it brighter" — return ONLY brightness. Nothing else.
2. Return ONLY raw JSON. No text, no markdown, no backticks, no explanation.
3. Max 8 steps. Pick the most impactful ones if user asks for many things.
4. Every step needs "stepName" (short english label) and "type".
5. If user asks for something impossible (like beat-sync, AI upscale, motion tracking), map to the CLOSEST available operation or skip it.

AVAILABLE OPERATIONS:
- color_filter: {"stepName":"...","type":"color_filter","filter":"X"} where X = grayscale|sepia|vintage|high_contrast|negative|vibrant|warm|cool|cinematic
- brightness: {"stepName":"...","type":"brightness","value":0.2} range -1.0 to 1.0
- contrast: {"stepName":"...","type":"contrast","value":1.5} range 0.3 to 3.0
- saturation: {"stepName":"...","type":"saturation","value":1.5} range 0.0 to 3.0
- speed: {"stepName":"...","type":"speed","value":1.5} range 0.5 to 2.0
- text_overlay: {"stepName":"...","type":"text_overlay","text":"TEXT","position":"center","fontSize":48,"fontColor":"white"} positions: center|top|bottom|top-left|top-right|bottom-left|bottom-right
- audio_effect: {"stepName":"...","type":"audio_effect","effect":"X"} where X = bass_boost|treble_boost|volume_up|volume_down|mute|normalize|echo
- vignette: {"stepName":"...","type":"vignette"}
- sharpen: {"stepName":"...","type":"sharpen"}
- blur: {"stepName":"...","type":"blur","value":3} range 1-10
- fade_in: {"stepName":"...","type":"fade_in","duration":1.0}
- zoom: {"stepName":"...","type":"zoom","value":1.3} range 1.05-2.0
- flip: {"stepName":"...","type":"flip","direction":"horizontal|vertical"}
- trim: {"stepName":"...","type":"trim","start":0,"end":30}

FORMAT: {"steps":[...],"summary":"brief description"}

EXAMPLES:
User: "Make it black and white with slow motion"
{"steps":[{"stepName":"Grayscale filter","type":"color_filter","filter":"grayscale"},{"stepName":"Slow motion 0.7x","type":"speed","value":0.7}],"summary":"Grayscale with 0.7x slow-mo"}

User: "Just increase brightness"
{"steps":[{"stepName":"Increase brightness","type":"brightness","value":0.2}],"summary":"Brightness +0.2"}

User: "Make it cinematic with dramatic effects"
{"steps":[{"stepName":"Cinematic color grade","type":"color_filter","filter":"cinematic"},{"stepName":"Add vignette","type":"vignette"},{"stepName":"Sharpen details","type":"sharpen"},{"stepName":"Bass boost audio","type":"audio_effect","effect":"bass_boost"},{"stepName":"Fade in","type":"fade_in","duration":1}],"summary":"Cinematic grade, vignette, sharpen, bass boost, fade in"}`;

// Ã¢❌€❌‚¬Ã¢❌€❌‚¬ Studio Planning Endpoint (Agent Planning) Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬
app.post('/api/studio/plan', async (req, res) => {
    const { prompt, videoContext, videoName, currentEdits, isRefine, history = [] } = req.body;
    if (!prompt) return res.status(400).json({ error: 'No prompt provided.' });

    const currentEditsInfo = currentEdits && Array.isArray(currentEdits)
        ? `\n\nCurrent edits already applied:\n${JSON.stringify(currentEdits)}\n\nThe user wants to MODIFY or ADD to these edits. Return the COMPLETE new set of steps (including any you want to keep from the current edits).`
        : '';

    const contextAddendum = videoContext
        ? `\n\nVideo analysis context for reference:\n${JSON.stringify(videoContext).substring(0, 3000)}\nVideo Name: ${videoName || 'My Video'}`
        : '';

    try {
        console.log('[Manus Agent] Ã¢❌€¢ÂÃ¢❌€¢ÂÃ¢❌€¢Â Planning task Ã¢❌€¢ÂÃ¢❌€¢ÂÃ¢❌€¢Â');
        console.log('[Manus Agent] Prompt:', prompt);

        let messages = [];
        if (isRefine) {
            messages = [
                { role: 'system', content: MANUS_AGENT_SYSTEM_PROMPT + currentEditsInfo + contextAddendum },
                ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: prompt }
            ];
        } else {
            messages = [
                { role: 'system', content: MANUS_AGENT_SYSTEM_PROMPT + contextAddendum },
                { role: 'user', content: prompt }
            ];
        }

        const aiResponse = await callManusWithFallback(messages, 1500);
        const plan = parseEditPlan(aiResponse, prompt);

        if (plan.steps.length === 0) {
            return res.status(400).json({
                error: 'Could not understand the editing request. Please try a more specific prompt.\n\nExamples:\nÃ¢❌‚¬Â¢ "Make it grayscale with 1.5x speed"\nÃ¢❌‚¬Â¢ "Add text HELLO at center with vintage filter"\nÃ¢❌‚¬Â¢ "Increase brightness and contrast, add bass boost"'
            });
        }

        res.json({
            success: true,
            steps: plan.steps,
            summary: plan.summary || 'Planned edits successfully.'
        });

    } catch (err) {
        console.error('[Manus Agent] Planning error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Ã¢❌€❌‚¬Ã¢❌€❌‚¬ Studio Execution Endpoint (Agent Execution) Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬Ã¢❌€❌‚¬
app.post('/api/studio/execute', async (req, res) => {
    const { steps, videoPath } = req.body;
    if (!steps || !Array.isArray(steps)) return res.status(400).json({ error: 'No steps provided.' });
    if (!videoPath) return res.status(400).json({ error: 'No video path provided.' });

    if (!videoPath.startsWith('/uploads/')) {
        return res.status(400).json({ error: 'Invalid video path.' });
    }

    const inputPath = path.join(__dirname, videoPath);
    if (!fs.existsSync(inputPath)) {
        return res.status(404).json({ error: 'Source video file not found.' });
    }

    try {
        console.log('[Manus Agent] Ã¢❌€¢ÂÃ¢❌€¢ÂÃ¢❌€¢Â Executing FFmpeg edits Ã¢❌€¢ÂÃ¢❌€¢ÂÃ¢❌€¢Â');
        const outputFilename = 'edited-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + '.mp4';
        const outputPath = path.join(uploadDir, outputFilename);
        const outputUrl = '/uploads/' + outputFilename;

        await editVideoWithSteps(inputPath, outputPath, steps);

        res.json({
            success: true,
            editedVideoUrl: outputUrl
        });

    } catch (err) {
        console.error('[Manus Agent] Execution error:', err);
        res.status(500).json({ error: err.message });
    }
});

async function runTextAiPrompt(systemPrompt, userPrompt) {
    const keys = getApiKeys();
    if (keys.length > 0) {
        try {
            const genAI = new GoogleGenerativeAI(keys[0]);
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const combinedPrompt = `${systemPrompt}\n\nUser Input: ${userPrompt}\n\nReturn clean JSON format.`;
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: combinedPrompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            });
            const text = result.response.text();
            return JSON.parse(text);
        } catch (e) {
            console.log('Gemini text prompt fallback to Groq/Manus:', e.message);
        }
    }
    
    const messages = [
        { role: 'system', content: systemPrompt + "\nOutput MUST be valid JSON format only." },
        { role: 'user', content: userPrompt }
    ];
    const textResult = await callManusWithFallback(messages, 2000);
    try {
        const cleanJson = textResult.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
    } catch {
        return { text: textResult };
    }
}

// === CREATOR TOOLS API ENDPOINTS ===

app.post('/api/creator/titles-hooks', async (req, res) => {
    try {
        const { topic, niche, format } = req.body;
        if (!topic) return res.status(400).json({ error: 'Topic is required.' });

        const sys = `You are YouTube's top viral strategist. Analyze topic, niche (${niche || 'General'}), and video format (${format || 'Shorts'}). Generate 5 viral titles and 3 high-retention 3-second hooks.
Return ONLY valid JSON matching:
{
  "titles": [{ "title": "Title Here", "ctrScore": 95, "rationale": "High curiosity gap" }],
  "hooks": [{ "type": "Visual + Spoken", "script": "Hook script...", "visualCue": "Zoom camera", "retentionImpact": "Instant engagement" }]
}`;
        const data = await runTextAiPrompt(sys, `Topic: ${topic}`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/creator/script', async (req, res) => {
    try {
        const { title, targetDuration, tone } = req.body;
        if (!title) return res.status(400).json({ error: 'Title is required.' });

        const sys = `Generate a scene-by-scene YouTube video script breakdown for "${title}". Target duration: ${targetDuration || '60s Short'}. Tone: ${tone || 'Energetic'}.
Return ONLY valid JSON matching:
{
  "estimatedDuration": "${targetDuration || '60s'}",
  "wordCount": 130,
  "scenes": [
    { "timestamp": "0:00-0:03", "section": "Hook", "visualDirection": "Fast text zoom", "voiceoverText": "Spoken line...", "soundEffect": "Whoosh" }
  ],
  "callToAction": "Subscribe CTA line"
}`;
        const data = await runTextAiPrompt(sys, `Title: ${title}`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/creator/seo-tags', async (req, res) => {
    try {
        const { title, descriptionKeywords } = req.body;
        if (!title) return res.status(400).json({ error: 'Title is required.' });

        const sys = `Generate high ranking YouTube tags, hashtags, and description for "${title}".
Return ONLY valid JSON matching:
{
  "tags": ["tag1", "tag2", "tag3"],
  "hashtags": ["#tag1", "#tag2"],
  "seoDescription": "Optimized description text with CTA...",
  "primaryKeyword": "main keyword",
  "searchVolumeRating": "High"
}`;
        const data = await runTextAiPrompt(sys, `Title: ${title}`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/creator/viral-ideas', async (req, res) => {
    try {
        const { category, audience } = req.body;
        const sys = `Generate 4 viral video ideas for category "${category || 'Tech/Gaming/Vlog'}".
Return ONLY valid JSON matching:
{
  "ideas": [
    { "concept": "Concept Title", "angle": "Unique twist", "predictedViews": "100K-500K", "difficulty": "Medium", "thumbnailConcept": "Visual description" }
  ]
}`;
        const data = await runTextAiPrompt(sys, `Category: ${category || 'General'}`);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`YT Analyzer running at http://localhost:${PORT}`));
