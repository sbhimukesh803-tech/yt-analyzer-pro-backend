// app.js — YT Analyzer Pro — Full Dashboard Controller

document.addEventListener('DOMContentLoaded', () => {

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const dropZone           = document.getElementById('drop-zone');
    const fileInput          = document.getElementById('file-input');
    const uploadCard         = document.getElementById('upload-card');
    const processingCard     = document.getElementById('processing-card');
    const resultsDashboard   = document.getElementById('results-dashboard');
    const progressFill       = document.getElementById('progress-fill');
    const progressPercentage = document.getElementById('progress-percentage');
    const logsBody           = document.getElementById('logs-body');
    const videoPreview       = document.getElementById('video-preview');
    const fileNameEl         = document.getElementById('file-name');
    const fileSizeEl         = document.getElementById('file-size');
    const scoreCircle        = document.getElementById('score-circle');
    const scoreText          = document.getElementById('score-text');
    const potentialBadge     = document.getElementById('potential-badge');
    const potentialText      = document.getElementById('potential-text');
    const newAnalysisBtn     = document.getElementById('new-analysis-btn');
    const exportPdfBtn       = document.getElementById('export-pdf-btn');
    const exportJsonBtn      = document.getElementById('export-json-btn');
    const exportTxtBtn       = document.getElementById('export-txt-btn');
    const historyBtn         = document.getElementById('history-btn');
    const historyDrawer      = document.getElementById('history-drawer');
    const historyOverlay     = document.getElementById('history-overlay');
    const historyCloseBtn    = document.getElementById('history-close-btn');
    const historyList        = document.getElementById('history-list');
    const historyEmpty       = document.getElementById('history-empty');

    let currentFile     = null;
    let pollInterval    = null;
    let lastResultData  = null;
    let currentJobId    = null;
    let chatHistory     = [];
    let channelChatHistory = [];
    let currentChannelData = null;
    let currentVideoMeta = { width: 0, height: 0 };

    // ── Tab Switching ─────────────────────────────────────────────────────────
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels  = document.querySelectorAll('.tab-panel');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-tab');
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tabPanels.forEach(p => p.id === target ? p.classList.add('active') : p.classList.remove('active'));
        });
    });

    // ── Drag & Drop ───────────────────────────────────────────────────────────
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    ['dragleave', 'dragend'].forEach(t => dropZone.addEventListener(t, () => dropZone.classList.remove('drag-over')));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFileSelect(fileInput.files[0]); });

    // ── Thumbnail Analyzer ────────────────────────────────────────────────────
    const thumbToggle    = document.getElementById('thumb-analyzer-toggle');
    const thumbBody      = document.getElementById('thumb-analyzer-body');
    const thumbFileInput = document.getElementById('thumbnail-file-input');
    const thumbFileName  = document.getElementById('thumb-file-name');
    const analyzeThumbBtn= document.getElementById('analyze-thumb-btn');
    const thumbResultBox = document.getElementById('thumb-result-box');
    const thumbLoading   = document.getElementById('thumb-loading');
    let thumbFile        = null;

    thumbToggle.addEventListener('click', () => {
        thumbBody.classList.toggle('hidden');
        thumbToggle.querySelector('.toggle-icon').classList.toggle('rotated');
    });

    thumbFileInput.addEventListener('change', () => {
        if (thumbFileInput.files.length) {
            thumbFile = thumbFileInput.files[0];
            thumbFileName.textContent = thumbFile.name;
            analyzeThumbBtn.classList.remove('hidden');
            thumbResultBox.classList.add('hidden');
        }
    });

    analyzeThumbBtn.addEventListener('click', async () => {
        if (!thumbFile) return;
        analyzeThumbBtn.classList.add('hidden');
        thumbLoading.classList.remove('hidden');
        thumbResultBox.classList.add('hidden');
        const formData = new FormData();
        formData.append('thumbnail', thumbFile);
        try {
            const res = await fetch('/api/analyze-thumbnail', { method: 'POST', body: formData });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Analysis failed');
            renderThumbnailAnalysis(json.data);
        } catch (err) {
            thumbResultBox.innerHTML = `<p style="color:#f87171;">Error: ${err.message}</p>`;
            thumbResultBox.classList.remove('hidden');
        } finally {
            thumbLoading.classList.add('hidden');
            analyzeThumbBtn.classList.remove('hidden');
        }
    });

    function renderThumbnailAnalysis(data) {
        const scoreColor = data.thumbnailScore >= 75 ? '#4ade80' : data.thumbnailScore >= 50 ? '#facc15' : '#f87171';
        thumbResultBox.innerHTML = `
            <div class="thumb-score-header">
                <div class="thumb-score-circle" style="border-color:${scoreColor};color:${scoreColor};">${data.thumbnailScore}<small>/100</small></div>
                <div>
                    <div class="thumb-ctr-badge" style="background:${scoreColor}20;color:${scoreColor};border:1px solid ${scoreColor}40;">CTR Potential: ${data.ctRPotential||'N/A'}</div>
                    <p style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-muted);">${data.overallVerdict||''}</p>
                </div>
            </div>
            <div class="thumb-analysis-cols">
                <div><h5 style="color:#4ade80;margin-bottom:0.4rem;"><i class="fa-solid fa-check"></i> Strengths</h5><ul class="suggestions-list">${(data.strengths||[]).map(s=>`<li>${s}</li>`).join('')}</ul></div>
                <div><h5 style="color:#f87171;margin-bottom:0.4rem;"><i class="fa-solid fa-xmark"></i> Weaknesses</h5><ul class="suggestions-list">${(data.weaknesses||[]).map(w=>`<li>${w}</li>`).join('')}</ul></div>
            </div>
            <h5 style="margin:0.75rem 0 0.4rem;"><i class="fa-solid fa-wand-magic-sparkles"></i> Improvements</h5>
            <ul class="suggestions-list">${(data.improvements||[]).map(i=>`<li>${i}</li>`).join('')}</ul>
            <div class="thumb-detail-row">
                <div><strong>Colors:</strong> <span>${data.colorAnalysis||''}</span></div>
                <div><strong>Text:</strong> <span>${data.textAnalysis||''}</span></div>
                <div><strong>Emotion:</strong> <span>${data.emotionImpact||''}</span></div>
                <div><strong>Face:</strong> <span>${data.facePresence||''}</span></div>
            </div>
            ${data.heatmapZones ? `<h5 style="margin:0.75rem 0 0.4rem;"><i class="fa-solid fa-eye"></i> Heatmap Simulation</h5>
            <div class="heatmap-zones">${data.heatmapZones.map(z=>`<div class="heatmap-zone"><span class="hz-label">${z.zone}</span><span class="hz-focus ${z.focus.toLowerCase()}">${z.focus}</span><span class="hz-reason">${z.reason}</span></div>`).join('')}</div>` : ''}
        `;
        thumbResultBox.classList.remove('hidden');
    }

    // ── History Drawer ────────────────────────────────────────────────────────
    historyBtn.addEventListener('click', openHistory);
    historyCloseBtn.addEventListener('click', closeHistory);
    historyOverlay.addEventListener('click', closeHistory);

    function openHistory() {
        loadHistoryList();
        historyDrawer.classList.add('open');
        historyOverlay.classList.add('visible');
    }
    function closeHistory() {
        historyDrawer.classList.remove('open');
        historyOverlay.classList.remove('visible');
    }
    function loadHistoryList() {
        const history = getSavedHistory();
        historyList.innerHTML = '';
        if (history.length === 0) { historyEmpty.style.display = 'flex'; return; }
        historyEmpty.style.display = 'none';
        history.forEach((entry, idx) => {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <div class="history-item-info">
                    <div class="history-item-name"><i class="fa-solid fa-file-video"></i> ${entry.filename}</div>
                    <div class="history-item-date">${new Date(entry.savedAt).toLocaleString()}</div>
                    <div class="history-item-score">Score: ${entry.rating}/10 · ${entry.viewsPotential}</div>
                </div>
                <div class="history-item-actions">
                    <button class="history-load-btn" data-idx="${idx}"><i class="fa-solid fa-eye"></i> View</button>
                    <button class="history-del-btn" data-idx="${idx}"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
            historyList.appendChild(div);
        });
        historyList.querySelectorAll('.history-load-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const entry = getSavedHistory()[parseInt(btn.dataset.idx)];
                if (entry) {
                    lastResultData = entry.result;
                    window.lastStudioVideoPath = entry.videoPath || '';
                    currentJobId = null;
                    chatHistory = [];
                    uploadCard.classList.add('hidden');
                    processingCard.classList.add('hidden');
                    resultsDashboard.classList.remove('hidden');
                    renderResults(entry.result, entry.filename, entry.size);
                    closeHistory();
                }
            });
        });
        historyList.querySelectorAll('.history-del-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const h = getSavedHistory();
                h.splice(parseInt(btn.dataset.idx), 1);
                localStorage.setItem('ytAnalyzerHistory', JSON.stringify(h));
                loadHistoryList();
            });
        });
    }
    function getSavedHistory() {
        try { return JSON.parse(localStorage.getItem('ytAnalyzerHistory') || '[]'); } catch { return []; }
    }
    function saveToHistory(data, filename, size, videoPath) {
        const history = getSavedHistory();
        history.unshift({ filename: filename || 'Unknown', size: size || 0, rating: data.rating || 0, viewsPotential: data.viewsPotential || 'Unknown', savedAt: Date.now(), result: data, videoPath: videoPath || '' });
        if (history.length > 10) history.pop();
        localStorage.setItem('ytAnalyzerHistory', JSON.stringify(history));
    }

    // ── File Select → Upload ──────────────────────────────────────────────────
    function handleFileSelect(file) {
        const validTypes = ['video/mp4', 'video/webm'];
        if (!validTypes.includes(file.type)) { alert('Unsupported format. Use MP4 or WebM.'); return; }
        if (file.size > 100 * 1024 * 1024) { alert('File exceeds 100MB limit.'); return; }
        currentFile = file;
        const videoEl = document.createElement('video');
        videoEl.preload = 'metadata';
        videoEl.src = URL.createObjectURL(file);
        videoEl.onloadedmetadata = () => {
            currentVideoMeta = { width: videoEl.videoWidth || 0, height: videoEl.videoHeight || 0 };
            URL.revokeObjectURL(videoEl.src);
            uploadFile(file, videoEl.videoHeight > videoEl.videoWidth ? '9:16' : '16:9');
        };
        videoEl.onerror = () => uploadFile(file, '16:9');
    }

    function uploadFile(file, videoAspect) {
        uploadCard.classList.add('hidden');
        processingCard.classList.remove('hidden');
        updateProgress(0);
        logsBody.innerHTML = '';
        addLog('Connecting to local server...');
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/analyze');
        xhr.upload.addEventListener('progress', e => { if (e.lengthComputable) updateProgress(Math.round((e.loaded / e.total) * 25)); });
        xhr.onload = function() {
            if (xhr.status === 200) {
                try {
                    const resp = JSON.parse(xhr.responseText);
                    if (resp.success && resp.jobId) { currentJobId = resp.jobId; chatHistory = []; addLog('Upload done! Starting AI analysis...'); startPolling(resp.jobId); }
                    else handleError(resp.error || 'Failed to register job.');
                } catch { handleError('Error parsing server response.'); }
            } else {
                try { handleError(JSON.parse(xhr.responseText).error || `Server error: ${xhr.status}`); }
                catch { handleError(`Server returned code: ${xhr.status}`); }
            }
        };
        xhr.onerror = () => handleError('Network error during upload.');
        const fd = new FormData();
        fd.append('video', file);
        fd.append('videoAspect', videoAspect);
        fd.append('videoWidth', currentVideoMeta.width || 0);
        fd.append('videoHeight', currentVideoMeta.height || 0);
        xhr.send(fd);
    }

    function startPolling(jobId) {
        addLog('Waiting for analysis worker...');
        let lastLogCount = 0;
        pollInterval = setInterval(async () => {
            try {
                const res = await fetch(`/api/job/${jobId}`);
                if (!res.ok) throw new Error('API unreachable.');
                const job = await res.json();
                if (job.logs && job.logs.length > lastLogCount) {
                    for (let i = lastLogCount; i < job.logs.length; i++) addLog(job.logs[i]);
                    lastLogCount = job.logs.length;
                }
                updateProgress(25 + Math.round(job.progress * 0.75));
                if (job.status === 'completed') {
                    clearInterval(pollInterval);
                    updateProgress(100);
                    addLog('Rendering dashboard...');
                    lastResultData = job.result;
                    window.lastStudioVideoPath = job.videoPath || '';
                    saveToHistory(job.result, currentFile?.name || 'Unknown', currentFile?.size || 0, job.videoPath);
                    setTimeout(() => renderResults(job.result, currentFile?.name, currentFile?.size), 800);
                } else if (job.status === 'failed') {
                    clearInterval(pollInterval);
                    handleError(job.error || 'Analysis failed.');
                }
            } catch (err) { clearInterval(pollInterval); handleError(`Polling error: ${err.message}`); }
        }, 2000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MASTER RENDER FUNCTION
    // ─────────────────────────────────────────────────────────────────────────
    function renderResults(data, filename, size) {
        processingCard.classList.add('hidden');
        resultsDashboard.classList.remove('hidden');
        tabButtons.forEach((b, i) => i === 0 ? b.classList.add('active') : b.classList.remove('active'));
        tabPanels.forEach((p, i) => i === 0 ? p.classList.add('active') : p.classList.remove('active'));

        // Pass analysis context to Studio
        if (window.setStudioContext) window.setStudioContext(data, filename, window.lastStudioVideoPath);

        // Video preview
        if (currentFile) {
            videoPreview.src = URL.createObjectURL(currentFile);
            videoPreview.onloadedmetadata = () => {
                videoPreview.parentElement.classList.toggle('vertical', videoPreview.videoHeight > videoPreview.videoWidth);
            };
            fileNameEl.innerHTML = `<i class="fa-solid fa-file-video"></i> ${currentFile.name}`;
            fileSizeEl.innerText = `${(currentFile.size / (1024*1024)).toFixed(1)} MB`;
        } else if (filename) {
            fileNameEl.innerHTML = `<i class="fa-solid fa-file-video"></i> ${filename}`;
            fileSizeEl.innerText = size ? `${(size / (1024*1024)).toFixed(1)} MB` : '';
        }

        // Score
        const rating = data.rating || 5.0;
        scoreText.innerText = rating.toFixed(1);
        scoreCircle.setAttribute('stroke-dasharray', `${Math.round(rating * 10)}, 100`);
        const potential = data.viewsPotential || 'Medium';
        potentialText.innerText = potential;
        potentialBadge.className = 'potential-badge ' + (potential.toLowerCase() === 'high' ? 'high' : potential.toLowerCase() === 'low' ? 'low' : 'medium');

        // Viral scores
        if (data.viralScore) {
            const vs = data.viralScore;
            renderViralScore('vs-overall', vs.overall || 0);
            renderViralScore('vs-entertainment', vs.entertainment || 0);
            renderViralScore('vs-watchability', vs.watchability || 0);
            renderViralScore('vs-shareability', vs.shareability || 0);
            renderViralScore('vs-engagement', vs.engagementPotential || 0);
        }

        // Algorithm audit
        const algo = data.algorithmSimulation || {};
        setTimeout(() => {
            setBar('algo-ctr-fill', 'algo-ctr-val', algo.ctrScore || 0, '%');
            setBar('algo-hook-fill', 'algo-hook-val', algo.hookStrength || 0, '%');
        }, 300);
        const retVal = document.getElementById('algo-retention-val');
        const risk = algo.retentionRisk || 'Low';
        retVal.innerText = risk;
        retVal.className = 'stat-badge ' + (risk === 'Low' ? 'badge-green' : risk === 'Medium' ? 'badge-yellow' : 'badge-red');
        setText('algo-feedback-text', algo.algorithmFeedback || '');
        renderAlgorithmDetails(algo);

        // Content badges
        renderContentBadges(data);

        // Quick Stats
        renderQuickStats(data);

        // ── TAB 1: REVIEW ──────────────────────────────────────────────────────
        if (data.feedback) {
            setText('feedback-visual', data.feedback.visualQuality);
            setText('feedback-audio', data.feedback.audioQuality);
            setText('feedback-hook', data.feedback.hook);
            setText('feedback-editing', data.feedback.editingStyle);
            renderList('suggestions-list', data.feedback.improvementSuggestions || []);
        }

        // Storytelling
        if (data.storytellingAnalysis) {
            const sa = data.storytellingAnalysis;
            const grid = document.getElementById('storytelling-grid');
            grid.innerHTML = '';
            const parts = [
                { icon: 'fa-door-open', label: 'Introduction', val: sa.introduction },
                { icon: 'fa-explosion', label: 'Conflict', val: sa.conflict },
                { icon: 'fa-stairs', label: 'Build-up', val: sa.buildUp },
                { icon: 'fa-mountain-sun', label: 'Climax', val: sa.climax },
                { icon: 'fa-flag-checkered', label: 'Ending', val: sa.ending },
            ];
            parts.forEach(p => {
                const div = document.createElement('div');
                div.className = 'storytelling-part';
                div.innerHTML = `<i class="fa-solid ${p.icon}"></i><span class="st-label">${p.label}</span><p class="st-val">${p.val || 'N/A'}</p>`;
                grid.appendChild(div);
            });
            setText('storytelling-arc', sa.overallArc || '');
        }

        // Pacing
        if (data.pacingAnalysis) {
            const pa = data.pacingAnalysis;
            const badge = document.getElementById('pacing-overall');
            badge.innerText = pa.overallPace || 'N/A';
            badge.className = 'pacing-overall-badge';
            renderTimestampList('pacing-fast-list', pa.tooFastSections || [], '⚡ Too Fast', '#f97316');
            renderTimestampList('pacing-slow-list', pa.tooSlowSections || [], '🐢 Too Slow', '#60a5fa');
            renderList('pacing-recommendations', pa.recommendations || []);
        }

        // Humor
        if (data.humorAnalysis) {
            const ha = data.humorAnalysis;
            const hc = document.getElementById('humor-score-circle');
            const hv = document.getElementById('humor-score-val');
            hv.innerText = ha.funniness || 0;
            const hcolor = (ha.funniness||0) >= 70 ? '#4ade80' : (ha.funniness||0) >= 40 ? '#facc15' : '#f87171';
            hc.style.borderColor = hcolor; hc.style.color = hcolor;
            const momList = document.getElementById('humor-moments-list');
            momList.innerHTML = (ha.moments||[]).map(m => `<p><strong>${m.timestamp}:</strong> ${m.type} (${m.effectiveness})</p>`).join('');
            renderList('humor-suggestions', ha.suggestions || []);
        }

        // ── TAB 2: DEEP ANALYSIS ───────────────────────────────────────────────
        if (data.hookAnalysis) {
            const h = data.hookAnalysis;
            const hc = document.getElementById('hook-score-circle');
            const hv = document.getElementById('hook-score-val');
            hv.innerText = h.rating || 0;
            const hcolor = (h.rating||0) >= 7 ? '#4ade80' : (h.rating||0) >= 5 ? '#facc15' : '#f87171';
            hc.style.borderColor = hcolor; hc.style.color = hcolor;
            setText('hook-text', h.hookText);
            setText('hook-retention-pred', h.retentionPrediction);
            renderList('hook-suggestions-list', h.hookSuggestions || []);
        }

        // Face Expression
        if (data.faceExpressionAnalysis) {
            const fa = data.faceExpressionAnalysis;
            const box = document.getElementById('face-analysis-box');
            if (!fa.detected) {
                box.innerHTML = `<p class="section-hint">No face detected in this video.</p>`;
            } else {
                box.innerHTML = `
                    <div class="broll-list">${(fa.emotionalMoments||[]).map(m => `
                        <div class="broll-item">
                            <span class="broll-ts">${m.timestamp}</span>
                            <span class="broll-text"><strong>${m.emotion}</strong> — Intensity: ${m.intensity}</span>
                        </div>`).join('')}
                    </div>
                    ${fa.peakImpactMoment ? `<p class="feedback-text" style="margin-top:0.5rem;"><strong>🌟 Peak Moment:</strong> ${fa.peakImpactMoment}</p>` : ''}
                `;
            }
            renderList('face-suggestions', fa.suggestions || []);
        }

        // Voice Energy
        if (data.voiceEnergyAnalysis) {
            const ve = data.voiceEnergyAnalysis;
            const vsr = document.getElementById('voice-stats-row');
            vsr.innerHTML = `
                <div class="voice-stat-pill"><i class="fa-solid fa-bolt"></i><span>${ve.overallEnergy || 'N/A'}</span><small>Energy</small></div>
                <div class="voice-stat-pill"><i class="fa-solid fa-gauge-high"></i><span>${ve.averageSpeakingSpeed || 'N/A'}</span><small>Speed</small></div>
            `;
            renderTimestampList('monotone-sections-list', ve.monotoneSections || [], '📉 Monotone Section', '#60a5fa');
            renderList('voice-recommendations', ve.recommendations || []);
        }

        // Retention Map
        if (data.retentionMap) {
            const retMap = document.getElementById('retention-map');
            retMap.innerHTML = '';
            data.retentionMap.forEach(seg => {
                const div = document.createElement('div');
                div.className = `retention-segment risk-${(seg.riskLevel||'low').toLowerCase()}`;
                div.innerHTML = `<div class="ret-seg-header"><span class="ret-timestamp">${seg.timestamp}</span><span class="ret-risk-badge risk-${(seg.riskLevel||'low').toLowerCase()}">${seg.riskLevel||'Low'} Risk</span></div><p class="ret-note">${seg.note||''}</p>`;
                retMap.appendChild(div);
            });
        }

        // Highlight Moments
        renderTimestampScore('highlight-moments-list', data.highlightMoments || []);

        // Replay Moments
        const replayList = document.getElementById('replay-moments-list');
        replayList.innerHTML = '';
        (data.replayMoments || []).forEach(item => {
            const div = document.createElement('div');
            div.className = 'broll-item';
            div.innerHTML = `<span class="broll-ts">${item.timestamp}</span><span class="broll-text">${item.description} — <em>${item.reason}</em></span>`;
            replayList.appendChild(div);
        });

        // Meme Potential
        if (data.memePotential) {
            const mp = data.memePotential;
            const mc = document.getElementById('meme-score-circle');
            const mv = document.getElementById('meme-score-val');
            mv.innerText = mp.score || 0;
            const mcolor = (mp.score||0) >= 70 ? '#4ade80' : (mp.score||0) >= 40 ? '#facc15' : '#f87171';
            mc.style.borderColor = mcolor; mc.style.color = mcolor;
            const mclips = document.getElementById('meme-clips-list');
            mclips.innerHTML = '';
            (mp.clipSuggestions || []).forEach(clip => {
                const div = document.createElement('div');
                div.className = 'broll-item';
                div.innerHTML = `<span class="broll-ts">${clip.timestamp}</span><span class="broll-text"><strong>${clip.description}</strong><br><em style="color:#a78bfa;">${clip.whyViral}</em></span>`;
                mclips.appendChild(div);
            });
        }

        // Shorts Clip Suggestions
        const scl = document.getElementById('shorts-clips-list');
        scl.innerHTML = '';
        (data.shortsClipSuggestions || []).forEach((clip, i) => {
            const div = document.createElement('div');
            div.className = 'shorts-clip-card';
            div.innerHTML = `
                <div class="shorts-clip-header">
                    <span class="shorts-clip-num">#${i+1}</span>
                    <span class="shorts-clip-title">${clip.title}</span>
                </div>
                <div class="shorts-clip-times"><i class="fa-solid fa-play"></i> ${clip.startTime} — <i class="fa-solid fa-stop"></i> ${clip.endTime}</div>
                <p class="shorts-clip-reason">${clip.viralReason}</p>
            `;
            scl.appendChild(div);
        });

        // Competitor
        if (data.competitorInsights) {
            setText('competitor-style', data.competitorInsights.similarChannelStyle);
            renderList('competitor-missing', data.competitorInsights.missingElements || []);
            renderList('competitor-inspired', data.competitorInsights.inspiredImprovements || []);
        }

        // A/B Test
        if (data.abTitleTest) {
            const ab = data.abTitleTest;
            document.getElementById('ab-title-a').innerText = ab.titleA || '';
            document.getElementById('ab-title-b').innerText = ab.titleB || '';
            const winner = (ab.predictedWinner || 'A').toUpperCase();
            document.getElementById('ab-winner-text').innerText = `Title ${winner}`;
            setText('ab-reasoning', ab.reasoning);
            document.getElementById('ab-card-a').classList.toggle('winner', winner === 'A');
            document.getElementById('ab-card-b').classList.toggle('winner', winner === 'B');
        }

        // Shorts Suitability
        if (data.shortsAnalysis) {
            const badge = document.getElementById('shorts-badge');
            badge.innerText = data.shortsAnalysis.isSuitable ? '✅ Suitable for Shorts' : '❌ Not Ideal for Shorts';
            badge.className = `shorts-badge ${data.shortsAnalysis.isSuitable ? 'shorts-yes' : 'shorts-no'}`;
            setText('shorts-reasoning', data.shortsAnalysis.reasoning);
            document.getElementById('shorts-duration').innerText = data.shortsAnalysis.recommendedDuration || 'N/A';
        }

        // ── TAB 3: SEO ─────────────────────────────────────────────────────────
        const seoTitles = document.getElementById('seo-titles');
        seoTitles.innerHTML = '';
        if (data.metadata?.titles) {
            let idx = 0;
            const addTitleGroup = (label, list) => {
                const h = document.createElement('h4');
                h.style.cssText = 'margin:1rem 0 0.5rem;color:var(--text-muted);font-size:0.9rem;';
                h.innerText = label; seoTitles.appendChild(h);
                list.forEach(title => {
                    const gIdx = idx++;
                    const box = document.createElement('div');
                    box.className = 'title-option-box';
                    box.innerHTML = `<span class="title-text" id="title-text-${gIdx}">${title}</span><button class="copy-btn" onclick="copySpecificTitle(${gIdx})"><i class="fa-solid fa-copy"></i></button>`;
                    seoTitles.appendChild(box);
                });
            };
            if (data.metadata.titles.english?.length) addTitleGroup('🇬🇧 English Titles', data.metadata.titles.english);
            if (data.metadata.titles.hindi?.length) addTitleGroup('🇮🇳 Hindi / Hinglish Titles', data.metadata.titles.hindi);
        }

        const descriptions = data.metadata?.descriptions || [];
        const descTextarea = document.getElementById('seo-description');
        descTextarea.value = descriptions[0] || '';
        const freshDescTabs = document.querySelectorAll('.desc-tab-btn');
        freshDescTabs.forEach((tab, idx) => {
            idx === 0 ? tab.classList.add('active') : tab.classList.remove('active');
            tab.onclick = () => { freshDescTabs.forEach(t => t.classList.remove('active')); tab.classList.add('active'); descTextarea.value = descriptions[idx] || ''; };
        });
        document.getElementById('copy-desc-btn').onclick = () => copyRawText(descTextarea.value);

        // Hashtags
        const hashtagsList = data.metadata?.hashtags?.list || data.metadata?.hashtags || [];
        document.getElementById('hashtag-limit-guide').innerText = data.metadata?.hashtags?.recommendedQuantity || '';
        document.getElementById('tag-limit-guide').innerText = data.metadata?.tags?.recommendedQuantity || '';
        renderTagPills('seo-hashtags', Array.isArray(hashtagsList) ? hashtagsList : [], true);
        const tagsList = data.metadata?.tags?.list || data.metadata?.tags || [];
        renderTagPills('seo-tags', Array.isArray(tagsList) ? tagsList : [], false);

        // ── TAB 4: GROWTH ──────────────────────────────────────────────────────
        if (data.growthPrediction) {
            setText('pred-worst', data.growthPrediction.worstCase);
            setText('pred-avg', data.growthPrediction.averageCase);
            setText('pred-best', data.growthPrediction.bestCase);
            setText('pred-reasoning', data.growthPrediction.reasoning);
        }

        // Engagement Prediction
        if (data.engagementPrediction) {
            const ep = data.engagementPrediction;
            const egrid = document.getElementById('engagement-grid');
            egrid.innerHTML = '';
            const eItems = [
                { icon: 'fa-thumbs-up', label: 'Likes', val: ep.likes, color: '#4ade80' },
                { icon: 'fa-comments', label: 'Comments', val: ep.comments, color: '#60a5fa' },
                { icon: 'fa-share-nodes', label: 'Shares', val: ep.shares, color: '#f97316' },
                { icon: 'fa-user-plus', label: 'Subscribers', val: ep.subscribersGained, color: '#a78bfa' },
            ];
            eItems.forEach(item => {
                const div = document.createElement('div');
                div.className = 'engagement-card';
                div.innerHTML = `<i class="fa-solid ${item.icon}" style="color:${item.color}"></i><span class="eng-val" style="color:${item.color}">${item.val||'N/A'}</span><span class="eng-label">${item.label}</span>`;
                egrid.appendChild(div);
            });
            setText('engagement-reasoning', ep.reasoning);
        }

        // Subscriber Growth
        if (data.subscriberGrowthPrediction) {
            const sg = data.subscriberGrowthPrediction;
            const sgrid = document.getElementById('sub-growth-grid');
            sgrid.innerHTML = '';
            [{ label: '30 Days', val: sg.thirtyDay, color: '#facc15' }, { label: '90 Days', val: sg.ninetyDay, color: '#f97316' }, { label: '1 Year', val: sg.oneYear, color: '#4ade80' }].forEach(item => {
                const div = document.createElement('div');
                div.className = 'sub-growth-card';
                div.innerHTML = `<span class="sg-period">${item.label}</span><span class="sg-val" style="color:${item.color}">${item.val||'N/A'}</span>`;
                sgrid.appendChild(div);
            });
            setText('sub-growth-reasoning', sg.reasoning);
        }

        // Upload Timing
        if (data.uploadTiming) {
            setText('timing-day', data.uploadTiming.bestDay);
            setText('timing-time', data.uploadTiming.bestTime);
            setText('timing-reasoning', data.uploadTiming.reasoning);
            const ctg = document.getElementById('country-timing-grid');
            ctg.innerHTML = '';
            if (data.uploadTiming.countrySpecific) {
                Object.entries(data.uploadTiming.countrySpecific).forEach(([country, time]) => {
                    const div = document.createElement('div');
                    div.className = 'country-timing-item';
                    div.innerHTML = `<span class="country-flag">${getFlagEmoji(country)}</span><span class="country-name">${country}</span><span class="country-time">${time}</span>`;
                    ctg.appendChild(div);
                });
            }
        }

        // Audience
        if (data.audienceType) {
            setText('aud-primary', data.audienceType.primary);
            setText('aud-secondary', data.audienceType.secondary);
            setText('aud-profile', data.audienceType.audienceProfile);
            const ic = document.getElementById('aud-interests');
            ic.innerHTML = '';
            (data.audienceType.interests || []).forEach(i => {
                const pill = document.createElement('span');
                pill.className = 'tag-pill secondary'; pill.innerText = i;
                ic.appendChild(pill);
            });
        }

        // Content Calendar
        if (data.aiContentCalendar) {
            const ac = data.aiContentCalendar;
            setText('calendar-consistency', ac.consistency || '');
            const cg = document.getElementById('calendar-grid');
            cg.innerHTML = '';
            (ac.weeklyPlan || []).forEach(item => {
                const div = document.createElement('div');
                div.className = 'calendar-day-card';
                div.innerHTML = `<span class="cal-day">${item.day}</span><span class="cal-idea">${item.contentIdea}</span><span class="cal-format">${item.format}</span>`;
                cg.appendChild(div);
            });
        }

        // Series Planner
        if (data.seriesPlanner) {
            const sp = data.seriesPlanner;
            const stb = document.getElementById('series-title-box');
            stb.innerHTML = `<div class="series-title-tag"><i class="fa-solid fa-film"></i> ${sp.seriesTitle || 'Series'}</div>`;
            const el = document.getElementById('episode-list');
            el.innerHTML = '';
            (sp.episodePlan || []).forEach(ep => {
                const div = document.createElement('div');
                div.className = `episode-item ${ep.status === 'Done' ? 'done' : ''}`;
                div.innerHTML = `<span class="ep-num">Ep ${ep.episode}</span><div class="ep-info"><span class="ep-title">${ep.title}</span>${ep.topic ? `<span class="ep-topic">${ep.topic}</span>` : ''}</div>${ep.status === 'Done' ? '<span class="ep-done-badge">✅ Current</span>' : ''}`;
                el.appendChild(div);
            });
            renderList('sequel-ideas-list', sp.sequelIdeas || []);
        }

        // Channel Growth
        if (data.channelGrowthAdvice) {
            renderList('growth-video-ideas', data.channelGrowthAdvice.futureVideoIdeas || []);
            setText('growth-strategy', data.channelGrowthAdvice.contentStrategy);
        }

        // ── TAB 5: SCRIPT & EDITING ────────────────────────────────────────────
        document.getElementById('transcript-box').value = data.transcript || 'No speech detected in this video.';
        document.getElementById('script-rewrite-box').value = data.scriptRewrite || 'N/A';

        // Summary
        if (data.automaticSummary) {
            setText('short-summary', data.automaticSummary.shortSummary);
            renderList('key-points-list', data.automaticSummary.keyPoints || []);
        }

        // Chapters
        const chaptersList = document.getElementById('chapters-list');
        chaptersList.innerHTML = '';
        (data.autoChapters || []).forEach(ch => {
            const div = document.createElement('div');
            div.className = 'chapter-item';
            div.innerHTML = `<span class="chapter-ts">${ch.timestamp}</span><span class="chapter-title">${ch.title}</span>`;
            chaptersList.appendChild(div);
        });
        document.getElementById('copy-chapters-btn').onclick = () => {
            const text = (data.autoChapters || []).map(ch => `${ch.timestamp} ${ch.title}`).join('\n');
            copyRawText(text);
        };

        renderList('cta-list', data.ctaSuggestions || []);

        // B-Roll
        const brollList = document.getElementById('broll-list');
        brollList.innerHTML = '';
        (data.bRollSuggestions || []).forEach(item => {
            const div = document.createElement('div');
            div.className = 'broll-item';
            div.innerHTML = `<span class="broll-ts">${item.timestamp}</span><span class="broll-text">${item.suggestion}</span>`;
            brollList.appendChild(div);
        });

        // SFX
        const sfxList = document.getElementById('sfx-list');
        sfxList.innerHTML = '';
        (data.sfxSuggestions || []).forEach(item => {
            const div = document.createElement('div');
            div.className = 'broll-item';
            div.innerHTML = `<span class="broll-ts">${item.timestamp}</span><span class="broll-text"><i class="fa-solid fa-volume-high"></i> ${item.effect}</span>`;
            sfxList.appendChild(div);
        });

        // Music
        if (data.musicSuggestion) {
            const ms = data.musicSuggestion;
            const styleMap = { energetic:'#f97316', cinematic:'#a78bfa', funny:'#facc15', emotional:'#60a5fa' };
            const color = styleMap[(ms.style||'').toLowerCase()] || '#a78bfa';
            document.getElementById('music-style-card').innerHTML = `
                <div class="music-style-tag" style="background:${color}20;color:${color};border:1px solid ${color}40;"><i class="fa-solid fa-music"></i> ${ms.style||'N/A'}</div>
                <p class="music-reason">${ms.reason||''}</p>
                <div class="music-examples">${(ms.examples||[]).map(e=>`<span class="tag-pill secondary">${e}</span>`).join('')}</div>
            `;
        }

        // Subtitle highlights
        const subCont = document.getElementById('subtitle-highlights');
        subCont.innerHTML = '';
        (data.subtitleHighlights || []).forEach(word => {
            const pill = document.createElement('span');
            pill.className = 'tag-pill highlight-pill'; pill.innerText = word;
            subCont.appendChild(pill);
        });

        // Scene & Key Frames
        renderTimestampDescription('scene-list', data.sceneList || []);
        if (data.frameSummary) {
            renderTimestampDescription('key-frames-list', data.frameSummary.keyFrames || []);
        }

        // AI Improvement Score
        if (data.aiImprovementScore) {
            const ais = data.aiImprovementScore;
            const box = document.getElementById('improvement-score-box');
            const pct = Math.round(((ais.potentialScore - ais.currentScore) / (100 - ais.currentScore)) * 100);
            box.innerHTML = `
                <div class="improve-score-row">
                    <div class="improve-score-item"><span class="improve-score-label">Current</span><span class="improve-score-val now">${ais.currentScore}</span></div>
                    <div class="improve-score-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>
                    <div class="improve-score-item"><span class="improve-score-label">Potential</span><span class="improve-score-val potential">${ais.potentialScore}</span></div>
                    <div class="improve-score-item"><span class="improve-score-label">Gap</span><span class="improve-score-val gap">+${ais.improvementGap}</span></div>
                </div>
                <div class="improve-bar-container"><div class="improve-bar-fill" style="width:${pct}%"></div></div>
            `;
            renderList('improvement-changes-list', ais.keyChangesNeeded || []);
            setText('improvement-time', ais.timeToImprove || '');
        }

        // Silence Detector
        if (data.silenceDetection) {
            const sd = data.silenceDetection;
            setText('silence-estimate', sd.totalSilenceEstimate || '');
            const sl = document.getElementById('silence-list');
            sl.innerHTML = '';
            (sd.unnecessaryPauses || []).forEach(item => {
                const div = document.createElement('div');
                div.className = 'broll-item';
                div.innerHTML = `<span class="broll-ts">${item.timestamp}</span><span class="broll-text"><strong>${item.duration}</strong> — ${item.suggestion}</span>`;
                sl.appendChild(div);
            });
            setText('silence-verdict', sd.overallVerdict || '');
        }

        // ── TAB 6: VIDEO INTEL ─────────────────────────────────────────────────

        // Niche
        if (data.nicheDetector) {
            const nd = data.nicheDetector;
            const ng = document.getElementById('niche-grid');
            ng.innerHTML = `
                <div class="niche-card primary"><span class="niche-label">Primary</span><span class="niche-val">${nd.primaryNiche||'N/A'}</span><span class="niche-conf">${nd.confidence||0}% confident</span></div>
                <div class="niche-card secondary"><span class="niche-label">Secondary</span><span class="niche-val">${nd.secondaryNiche||'N/A'}</span></div>
            `;
            const st = document.getElementById('niche-sub-tags');
            st.innerHTML = '';
            (nd.subNiches || []).forEach(n => { const p = document.createElement('span'); p.className = 'tag-pill'; p.innerText = n; st.appendChild(p); });
            setText('niche-monetization-fit', nd.monetizationFit || '');
        }

        // Monetization
        if (data.monetizationScore) {
            const ms = data.monetizationScore;
            const mg = document.getElementById('monetization-grid');
            mg.innerHTML = `
                <div class="monetization-item"><i class="fa-solid fa-dollar-sign"></i><span class="mono-label">CPM Potential</span><span class="mono-val">${ms.cpmPotential||'N/A'}</span></div>
                <div class="monetization-item"><i class="fa-solid fa-shield-check"></i><span class="mono-label">Advertiser Friendly</span><span class="mono-val">${ms.advertiserFriendliness||'N/A'}</span></div>
                <div class="monetization-item"><i class="fa-solid fa-money-bill-trend-up"></i><span class="mono-label">Revenue Estimate</span><span class="mono-val">${ms.revenueEstimate||'N/A'}</span></div>
            `;
            setText('monetization-reasoning', ms.reasoning || '');
        }

        // Sponsor
        if (data.sponsorOpportunityScore) {
            const so = data.sponsorOpportunityScore;
            const sc = document.getElementById('sponsor-score-circle');
            const sv = document.getElementById('sponsor-score-val');
            sv.innerText = so.score || 0;
            const socolor = (so.score||0) >= 70 ? '#4ade80' : (so.score||0) >= 40 ? '#facc15' : '#f87171';
            sc.style.borderColor = socolor; sc.style.color = socolor;
            setText('sponsor-friendly', so.brandFriendliness);
            const pb = document.getElementById('potential-brands');
            pb.innerHTML = '';
            (so.potentialBrands || []).forEach(b => { const p = document.createElement('span'); p.className = 'tag-pill secondary'; p.innerText = b; pb.appendChild(p); });
            setText('sponsor-reasoning', so.reasoning);
        }

        // Copyright Risk
        if (data.copyrightRisk) {
            const cr = data.copyrightRisk;
            const cg = document.getElementById('copyright-grid');
            const riskColor = r => r === 'Low' ? '#4ade80' : r === 'Medium' ? '#facc15' : '#f87171';
            cg.innerHTML = `
                <div class="risk-item"><i class="fa-solid fa-music" style="color:${riskColor(cr.musicRisk)}"></i><span>Music Risk</span><span class="risk-badge" style="color:${riskColor(cr.musicRisk)}">${cr.musicRisk||'N/A'}</span></div>
                <div class="risk-item"><i class="fa-solid fa-image" style="color:${riskColor(cr.visualRisk)}"></i><span>Visual Risk</span><span class="risk-badge" style="color:${riskColor(cr.visualRisk)}">${cr.visualRisk||'N/A'}</span></div>
                <div class="risk-item"><i class="fa-solid fa-triangle-exclamation" style="color:${riskColor(cr.overallRisk)}"></i><span>Overall Risk</span><span class="risk-badge" style="color:${riskColor(cr.overallRisk)}">${cr.overallRisk||'N/A'}</span></div>
            `;
            setText('copyright-verdict', cr.verdict || '');
        }

        // Community Guidelines
        if (data.communityGuidelineRisk) {
            const cgr = data.communityGuidelineRisk;
            const riskColor = r => r === 'Very Low' || r === 'Low' ? '#4ade80' : r === 'Medium' ? '#facc15' : '#f87171';
            const cgBox = document.getElementById('cg-risk-box');
            cgBox.innerHTML = `
                <div class="cg-risk-row">
                    <div class="cg-risk-pill" style="color:${riskColor(cgr.riskLevel)};border-color:${riskColor(cgr.riskLevel)}40;background:${riskColor(cgr.riskLevel)}15;">${cgr.riskLevel||'N/A'}</div>
                    <div class="cg-demonet-pill">Demonetization: <strong>${cgr.demonetizationRisk||'N/A'}</strong></div>
                </div>
            `;
            renderList('cg-concerns-list', cgr.concerns || []);
            setText('cg-verdict', cgr.verdict);
        }

        // Visual Quality Detailed
        if (data.visualQualityDetailed) {
            const vq = data.visualQualityDetailed;
            const vqg = document.getElementById('visual-quality-grid');
            vqg.innerHTML = [
                { label: 'Lighting', val: vq.lighting },
                { label: 'Color Grading', val: vq.colorGrading },
                { label: 'Camera Shake', val: vq.cameraShake },
                { label: 'Sharpness', val: vq.sharpness },
                { label: 'Overall Score', val: `${vq.score||0}/100` },
            ].map(it => `<div class="vq-item"><span class="vq-label">${it.label}</span><span class="vq-val">${it.val||'N/A'}</span></div>`).join('');
        }

        // Camera Movement
        if (data.cameraMovementAnalysis) {
            const cma = data.cameraMovementAnalysis;
            setText('camera-stability', `Stability: ${cma.stability || 'N/A'}`);
            renderTimestampList('camera-movements-list', cma.excessiveMovements || [], '📷 Excessive Movement', '#f87171');
            renderList('camera-recommendations', cma.recommendations || []);
        }

        // Background
        if (data.backgroundAnalysis) {
            const ba = data.backgroundAnalysis;
            const bdl = document.getElementById('background-distractions-list');
            bdl.innerHTML = '';
            (ba.distractions || []).forEach(d => {
                const div = document.createElement('div');
                div.className = 'broll-item';
                div.innerHTML = `<span class="broll-ts">${d.timestamp||'–'}</span><span class="broll-text">${d.description}</span>`;
                bdl.appendChild(div);
            });
            setText('background-suggestions', ba.suggestions ? ba.suggestions.join(' · ') : '');
        }

        // Editing Style
        if (data.editingStyleAnalysis) {
            const esa = data.editingStyleAnalysis;
            const esb = document.getElementById('editing-style-box');
            const styleColors = { 'fast-paced':'#f97316', 'cinematic':'#a78bfa', 'educational':'#60a5fa', 'gaming':'#4ade80', 'vlog':'#facc15' };
            const col = styleColors[(esa.style||'').toLowerCase()] || '#a78bfa';
            esb.innerHTML = `<div class="editing-style-tag" style="color:${col};border-color:${col}40;background:${col}15;"><i class="fa-solid fa-film"></i> ${esa.style||'N/A'}</div><span class="editing-conf">${esa.confidence||0}% confident</span>`;
            const ec = document.getElementById('editing-characteristics');
            ec.innerHTML = '';
            (esa.characteristics || []).forEach(c => { const p = document.createElement('span'); p.className = 'tag-pill secondary'; p.innerText = c; ec.appendChild(p); });
            renderList('editing-alternatives', esa.alternativeStyles || []);
        }

        // Similar Creators
        if (data.similarCreatorAnalysis) {
            const sca = data.similarCreatorAnalysis;
            const cl = document.getElementById('creators-list');
            cl.innerHTML = '';
            (sca.creators || []).forEach(c => {
                const div = document.createElement('div');
                div.className = 'creator-card';
                div.innerHTML = `
                    <div class="creator-name"><i class="fa-solid fa-user-tie"></i> ${c.name}</div>
                    <div class="creator-diff-row">
                        <div><span style="color:#4ade80;">✅ Strength:</span> ${c.strength}</div>
                        <div><span style="color:#f87171;">❌ Weakness:</span> ${c.weakness}</div>
                    </div>`;
                cl.appendChild(div);
            });
            setText('creator-differentiator', sca.differentiators || '');
            setText('creator-edge', sca.competitiveEdge || '');
        }

        // Trending Topics
        if (data.trendingTopicAnalysis) {
            const ta = data.trendingTopicAnalysis;
            const mt = document.getElementById('matching-trends');
            mt.innerHTML = '';
            (ta.matchingTrends || []).forEach(t => { const p = document.createElement('span'); p.className = 'tag-pill'; p.innerText = t; mt.appendChild(p); });
            renderList('trend-opportunities', ta.opportunities || []);
        }

        // Future Trends
        if (data.futureTrendPrediction) {
            const ft = data.futureTrendPrediction;
            setText('trend-timeframe', ft.timeframe || '');
            const ut = document.getElementById('upcoming-topics');
            ut.innerHTML = '';
            (ft.upcomingTopics || []).forEach(t => { const p = document.createElement('span'); p.className = 'tag-pill'; p.innerText = t; ut.appendChild(p); });
            renderList('future-content-ideas', ft.contentIdeas || []);
        }

        // Audio Quality Detailed
        if (data.audioQualityDetailed) {
            const aq = data.audioQualityDetailed;
            const aqg = document.getElementById('audio-quality-grid');
            const noiseColor = aq.noiseLevel === 'Low' ? '#4ade80' : aq.noiseLevel === 'Medium' ? '#facc15' : '#f87171';
            aqg.innerHTML = `
                <div class="aq-item"><i class="fa-solid fa-wind"></i><span class="aq-label">Noise Level</span><span class="aq-val" style="color:${noiseColor}">${aq.noiseLevel||'N/A'}</span></div>
                <div class="aq-item"><i class="fa-solid fa-wave-square"></i><span class="aq-label">Echo</span><span class="aq-val" style="color:${aq.echoDetected?'#f87171':'#4ade80'}">${aq.echoDetected?'Detected':'None'}</span></div>
                <div class="aq-item"><i class="fa-solid fa-star"></i><span class="aq-label">Clarity Score</span><span class="aq-val">${aq.clarityScore||0}/100</span></div>
                <div class="aq-item"><i class="fa-solid fa-microphone"></i><span class="aq-label">Mic Quality</span><span class="aq-val">${aq.microphoneQuality||'N/A'}</span></div>
                ${aq.backgroundMusicBalance ? `<div class="aq-item full-width"><i class="fa-solid fa-sliders"></i><span class="aq-label">Music Balance</span><span class="aq-val">${aq.backgroundMusicBalance}</span></div>` : ''}
            `;
            renderList('audio-recommendations', aq.recommendations || []);
        }

        // ── TAB 7: AI CHAT ─────────────────────────────────────────────────────
        if (data.aiVideoCoach) {
            const vc = data.aiVideoCoach;
            const ab = document.getElementById('coach-assessment-box');
            ab.innerHTML = `<p class="feedback-text">${vc.overallAssessment || ''}</p>`;
            renderList('coach-mistakes-list', vc.topMistakes || []);
            const ipl = document.getElementById('improvement-plan-list');
            ipl.innerHTML = '';
            (vc.improvementPlan || []).forEach(item => {
                const div = document.createElement('div');
                div.className = 'plan-step';
                const impactColor = item.impact === 'High' ? '#4ade80' : item.impact === 'Medium' ? '#facc15' : '#f87171';
                div.innerHTML = `
                    <div class="plan-step-num">${item.step}</div>
                    <div class="plan-step-info">
                        <p class="plan-step-action">${item.action}</p>
                        <div class="plan-step-tags">
                            <span style="color:${impactColor};border-color:${impactColor}40;background:${impactColor}15;" class="plan-tag">Impact: ${item.impact}</span>
                            <span class="plan-tag">Effort: ${item.effort}</span>
                        </div>
                    </div>`;
                ipl.appendChild(div);
            });
            const enc = document.getElementById('coach-encouragement');
            enc.innerHTML = vc.encouragement ? `<div class="encouragement-box"><i class="fa-solid fa-heart"></i> ${vc.encouragement}</div>` : '';
        }

        // Reset chat
        chatHistory = [];
        const chatMsgs = document.getElementById('chat-messages');
        chatMsgs.innerHTML = `
            <div class="chat-msg ai-msg">
                <div class="chat-avatar"><i class="fa-solid fa-robot"></i></div>
                <div class="chat-bubble">Hi! I've analyzed your video in detail. Ask me anything about it — hook strength, specific timestamps, editing decisions, growth strategies, or what to upload next! 🎬✨</div>
            </div>`;

        // Advisor quick QA
        const advisorBox = document.getElementById('advisor-quick-qa');
        advisorBox.innerHTML = '';
        if (data.aiVideoCoach) {
            const qs = [
                { q: "Why did this video perform poorly?", a: data.aiVideoCoach.overallAssessment || '' },
                { q: "What are the top mistakes?", a: (data.aiVideoCoach.topMistakes || []).join(' • ') },
                { q: "What is the improvement plan?", a: (data.aiVideoCoach.improvementPlan || []).map(s=>`${s.step}. ${s.action}`).join(' • ') },
            ];
            qs.forEach(qa => {
                const div = document.createElement('div');
                div.className = 'advisor-qa-item';
                div.innerHTML = `<div class="advisor-q"><i class="fa-solid fa-circle-question"></i> ${qa.q}</div><div class="advisor-a">${qa.a || 'See AI Coach report above.'}</div>`;
                advisorBox.appendChild(div);
            });
        }

        // ── TAB 8: UPLOAD ──────────────────────────────────────────────────────
        if (data.thumbnailImageUrl) {
            const thumbImg = document.getElementById('thumbnail-img');
            thumbImg.src = data.thumbnailImageUrl;
            const wrapper = document.getElementById('thumbnail-wrapper');
            wrapper.classList.toggle('vertical', data.videoAspect === '9:16');
            const dlLink = document.getElementById('thumbnail-download-link');
            dlLink.href = `/api/download-thumbnail?url=${encodeURIComponent(data.thumbnailImageUrl)}`;
            dlLink.setAttribute('download', data.videoAspect === '9:16' ? 'yt_shorts_thumbnail.jpg' : 'yt_thumbnail.jpg');
            document.getElementById('thumbnail-external-link').href = data.thumbnailImageUrl;
        }
        if (data.uploadStrategy) {
            setText('strategy-time', data.uploadStrategy.bestTime);
            setText('strategy-audience', data.uploadStrategy.audienceTarget);
            setText('strategy-thumbnail', data.uploadStrategy.thumbnailIdea);
            const stepsList = document.getElementById('strategy-steps');
            stepsList.innerHTML = '';
            (data.uploadStrategy.uploadSteps || []).forEach(step => { const li = document.createElement('li'); li.innerText = step; stepsList.appendChild(li); });
        }
    }

    // ── CHAT SEND ─────────────────────────────────────────────────────────────
    const chatInput  = document.getElementById('chat-input');
    const chatSendBtn= document.getElementById('chat-send-btn');
    const chatMsgsEl = document.getElementById('chat-messages');
    const suggestBtns = document.querySelectorAll('.chat-suggest-btn');

    suggestBtns.forEach(btn => {
        btn.addEventListener('click', () => { chatInput.value = btn.dataset.msg; sendChat(); });
    });

    chatSendBtn.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

    async function sendChat() {
        const message = chatInput.value.trim();
        if (!message) return;
        chatInput.value = '';

        appendChatMsg(message, 'user');
        const typingEl = appendTyping();

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: currentJobId, message, history: chatHistory })
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Chat failed');

            typingEl.remove();
            const reply = json.reply || 'Sorry, I could not generate a response.';
            appendChatMsg(reply, 'ai');
            chatHistory.push({ role: 'user', content: message });
            chatHistory.push({ role: 'model', content: reply });
        } catch (err) {
            typingEl.remove();
            appendChatMsg(`Error: ${err.message}`, 'ai');
        }
    }

    function appendChatMsg(text, role) {
        const msgsEl = document.getElementById('chat-messages');
        const div = document.createElement('div');
        div.className = `chat-msg ${role === 'ai' ? 'ai-msg' : 'user-msg'}`;
        if (role === 'ai') {
            div.innerHTML = `<div class="chat-avatar"><i class="fa-solid fa-robot"></i></div><div class="chat-bubble">${formatChatText(text)}</div>`;
        } else {
            div.innerHTML = `<div class="chat-bubble">${escapeHtml(text)}</div><div class="chat-avatar user-avatar"><i class="fa-solid fa-user"></i></div>`;
        }
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
        return div;
    }

    function appendTyping() {
        const msgsEl = document.getElementById('chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-msg ai-msg';
        div.innerHTML = `<div class="chat-avatar"><i class="fa-solid fa-robot"></i></div><div class="chat-bubble typing-bubble"><span></span><span></span><span></span></div>`;
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
        return div;
    }

    function renderAlgorithmDetails(algo = {}) {
        const detailGrid = document.getElementById('algo-detail-grid');
        const stageList = document.getElementById('algo-stage-list');
        const priorityList = document.getElementById('algo-priority-list');
        if (!detailGrid || !stageList || !priorityList) return;

        const seed = algo.seedAudienceTest || {};
        const signals = algo.rankingSignals || {};
        const signalItems = [
            { label: 'Seed Test', value: seed.passChance, icon: 'fa-user-check' },
            { label: '30s Retention', value: signals.firstThirtySecondsRetention, icon: 'fa-stopwatch' },
            { label: 'Satisfaction', value: signals.viewerSatisfaction, icon: 'fa-face-smile' },
            { label: 'Topic Demand', value: signals.topicDemand, icon: 'fa-chart-simple' },
            { label: 'Share Signal', value: signals.sharePotential, icon: 'fa-share-nodes' },
            { label: 'Safety', value: signals.policySafety, icon: 'fa-shield-halved' }
        ].filter(item => item.value !== undefined && item.value !== null);

        detailGrid.innerHTML = signalItems.map(item => {
            const score = Number(item.value) || 0;
            const color = score >= 75 ? '#4ade80' : score >= 50 ? '#facc15' : '#f87171';
            return `
                <div class="algo-detail-card">
                    <i class="fa-solid ${item.icon}" style="color:${color}"></i>
                    <span class="algo-detail-score" style="color:${color}">${score}%</span>
                    <span class="algo-detail-label">${item.label}</span>
                </div>`;
        }).join('');

        const stageHtml = (algo.distributionStages || []).map(stage => {
            const score = Number(stage.score) || 0;
            const color = score >= 75 ? '#4ade80' : score >= 50 ? '#facc15' : '#f87171';
            return `
                <div class="algo-stage-item">
                    <span class="algo-stage-score" style="color:${color};background:${color}15;border-color:${color}40;">${score}</span>
                    <div>
                        <strong>${escapeHtml(stage.stage || 'Stage')}</strong>
                        <p>${escapeHtml(stage.verdict || '')}</p>
                    </div>
                </div>`;
        }).join('');
        stageList.innerHTML = stageHtml + (seed.reason ? `<div class="algo-stage-item"><span class="algo-stage-score">AI</span><div><strong>Seed reason</strong><p>${escapeHtml(seed.reason)}</p></div></div>` : '');

        renderList('algo-priority-list', algo.actionPriorities || []);
    }

    // ── YouTube Channel Linking ─────────────────────────────────────────────
    const ytLinkBtn = document.getElementById('yt-link-btn');
    const channelLinkBtn = document.getElementById('channel-link-btn');
    const channelRefreshBtn = document.getElementById('channel-refresh-btn');
    const channelDisconnectBtn = document.getElementById('channel-disconnect-btn');
    const channelStatusText = document.getElementById('channel-status-text');
    const channelChatInput = document.getElementById('channel-chat-input');
    const channelChatSendBtn = document.getElementById('channel-chat-send-btn');

    ytLinkBtn?.addEventListener('click', () => openChannelTabAndLink());
    channelLinkBtn?.addEventListener('click', linkYoutubeAccount);
    channelRefreshBtn?.addEventListener('click', () => loadChannelData(true));
    channelDisconnectBtn?.addEventListener('click', disconnectYoutubeAccount);
    channelChatSendBtn?.addEventListener('click', sendChannelChat);
    channelChatInput?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChannelChat(); } });
    document.querySelectorAll('.channel-chat-suggest-btn').forEach(btn => {
        btn.addEventListener('click', () => { channelChatInput.value = btn.dataset.msg; sendChannelChat(); });
    });
    window.addEventListener('message', event => {
        if (event.origin === window.location.origin && event.data?.type === 'youtube-linked') loadChannelData(true);
    });

    function openChannelTabAndLink() {
        switchToTab('tab-channel');
        linkYoutubeAccount();
    }

    function switchToTab(tabId) {
        tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
        tabPanels.forEach(panel => panel.classList.toggle('active', panel.id === tabId));
    }

    async function linkYoutubeAccount() {
        setChannelStatus('Opening Google login...');
        try {
            const res = await fetch('/api/youtube/auth-url');
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Could not start YouTube linking.');
            window.open(json.authUrl, 'youtubeLink', 'width=520,height=720');
            setChannelStatus('Complete Google login, then this panel will refresh.');
        } catch (err) {
            setChannelStatus(err.message, true);
        }
    }

    async function loadChannelData(refresh = false) {
        setChannelStatus(refresh ? 'Refreshing channel data...' : 'Loading channel data...');
        try {
            const res = await fetch(`/api/youtube/channel${refresh ? '?refresh=1' : ''}`);
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Could not load channel.');
            currentChannelData = json.data;
            renderChannelData(json.data);
            setChannelStatus(`Linked. Last refresh: ${new Date(json.data.refreshedAt).toLocaleString()}`);
            checkApiStatus();
        } catch (err) {
            setChannelStatus(err.message, true);
        }
    }

    async function disconnectYoutubeAccount() {
        await fetch('/api/youtube/disconnect', { method: 'POST' });
        currentChannelData = null;
        channelChatHistory = [];
        document.getElementById('channel-summary-card').classList.add('hidden');
        document.getElementById('channel-videos-card').classList.add('hidden');
        document.getElementById('channel-chat-card').classList.add('hidden');
        setChannelStatus('Disconnected.');
        checkApiStatus();
    }

    function setChannelStatus(text, isError = false) {
        if (!channelStatusText) return;
        channelStatusText.textContent = text;
        channelStatusText.classList.toggle('error', isError);
    }

    function renderChannelData(data) {
        document.getElementById('channel-summary-card').classList.remove('hidden');
        document.getElementById('channel-videos-card').classList.remove('hidden');
        document.getElementById('channel-chat-card').classList.remove('hidden');

        const channel = data.channel || {};
        const stats = data.statistics || {};
        const summary = data.summary || {};
        document.getElementById('channel-avatar').src = channel.thumbnail || '';
        document.getElementById('channel-title').textContent = channel.title || 'YouTube Channel';
        document.getElementById('channel-description').textContent = channel.description || 'No channel description found.';
        const publicLink = document.getElementById('channel-public-link');
        publicLink.href = channel.customUrl ? `https://www.youtube.com/${channel.customUrl}` : `https://www.youtube.com/channel/${channel.id}`;

        const metricGrid = document.getElementById('channel-metrics-grid');
        metricGrid.innerHTML = [
            { icon: 'fa-users', label: 'Subscribers', value: stats.hiddenSubscriberCount ? 'Hidden' : formatNumber(stats.subscriberCount) },
            { icon: 'fa-eye', label: 'Channel Views', value: formatNumber(stats.viewCount) },
            { icon: 'fa-video', label: 'Videos', value: formatNumber(stats.videoCount) },
            { icon: 'fa-chart-line', label: 'Avg Views', value: formatNumber(summary.averageViews) },
            { icon: 'fa-mobile-screen', label: 'Shorts Avg', value: formatNumber(summary.averageShortViews) },
            { icon: 'fa-comments', label: 'Engagement', value: `${summary.engagementRate || 0}%` }
        ].map(item => `
            <div class="channel-metric">
                <i class="fa-solid ${item.icon}"></i>
                <span class="channel-metric-value">${item.value}</span>
                <span class="channel-metric-label">${item.label}</span>
            </div>`).join('');

        document.getElementById('channel-insight-strip').innerHTML = `
            <div><strong>Best format:</strong> ${escapeHtml(summary.bestFormat || 'Not enough data.')}</div>
            <div><strong>Upload cadence:</strong> ${escapeHtml(summary.uploadCadence || 'Unknown')}</div>
            <div><strong>Fetched:</strong> ${summary.totalVideosFetched || 0} uploads (${summary.shortsCount || 0} Shorts)</div>
        `;
        document.getElementById('channel-fetch-count').textContent = `${summary.totalVideosFetched || 0} fetched`;
        renderChannelVideos(data.videos || []);
        resetChannelChatIntro(data);
    }

    function renderChannelVideos(videos) {
        const list = document.getElementById('channel-videos-list');
        list.innerHTML = '';
        videos.slice(0, 30).forEach(video => {
            const item = document.createElement('a');
            item.className = 'channel-video-item';
            item.href = video.url;
            item.target = '_blank';
            item.innerHTML = `
                <img src="${escapeHtml(video.thumbnail)}" alt="">
                <div class="channel-video-info">
                    <div class="channel-video-title">${escapeHtml(video.title)}</div>
                    <div class="channel-video-meta">
                        <span>${video.type}</span>
                        <span>${formatNumber(video.viewCount)} views</span>
                        <span>${formatNumber(video.likeCount)} likes</span>
                        <span>${formatNumber(video.commentCount)} comments</span>
                        <span>${video.duration}</span>
                    </div>
                </div>
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
            `;
            list.appendChild(item);
        });
    }

    function resetChannelChatIntro(data) {
        channelChatHistory = [];
        const msgs = document.getElementById('channel-chat-messages');
        msgs.innerHTML = `
            <div class="chat-msg ai-msg">
                <div class="chat-avatar"><i class="fa-solid fa-robot"></i></div>
                <div class="chat-bubble">Channel linked. I can now answer using ${data.summary?.totalVideosFetched || 0} real uploads and your channel stats.</div>
            </div>`;
    }

    async function sendChannelChat() {
        const message = channelChatInput.value.trim();
        if (!message) return;
        channelChatInput.value = '';
        appendChannelChatMsg(message, 'user');
        const typingEl = appendChannelTyping();
        try {
            const res = await fetch('/api/channel-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message, history: channelChatHistory })
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || 'Channel chat failed.');
            typingEl.remove();
            appendChannelChatMsg(json.reply, 'ai');
            channelChatHistory.push({ role: 'user', content: message });
            channelChatHistory.push({ role: 'assistant', content: json.reply });
        } catch (err) {
            typingEl.remove();
            appendChannelChatMsg(`Error: ${err.message}`, 'ai');
        }
    }

    function appendChannelChatMsg(text, role) {
        const msgsEl = document.getElementById('channel-chat-messages');
        const div = document.createElement('div');
        div.className = `chat-msg ${role === 'ai' ? 'ai-msg' : 'user-msg'}`;
        div.innerHTML = role === 'ai'
            ? `<div class="chat-avatar"><i class="fa-solid fa-robot"></i></div><div class="chat-bubble">${formatChatText(text)}</div>`
            : `<div class="chat-bubble">${escapeHtml(text)}</div><div class="chat-avatar user-avatar"><i class="fa-solid fa-user"></i></div>`;
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
        return div;
    }

    function appendChannelTyping() {
        const msgsEl = document.getElementById('channel-chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-msg ai-msg';
        div.innerHTML = `<div class="chat-avatar"><i class="fa-solid fa-robot"></i></div><div class="chat-bubble typing-bubble"><span></span><span></span><span></span></div>`;
        msgsEl.appendChild(div);
        msgsEl.scrollTop = msgsEl.scrollHeight;
        return div;
    }

    // ── API Status ────────────────────────────────────────────────────────────
    async function checkApiStatus() {
        const badge = document.getElementById('api-status-badge');
        const warning = document.getElementById('api-key-warning');
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            if (data.geminiApiKeyConfigured) {
                const extras = [
                    data.groqConfigured ? 'Groq' : null,
                    data.youtubeLinked ? 'YT Linked' : null
                ].filter(Boolean).join(' + ');
                badge.innerHTML = `<span class="status-dot active"></span> ${data.keysCount} Gemini Key${data.keysCount > 1 ? 's' : ''}${extras ? ` + ${extras}` : ''}`;
                badge.style.color = '#86efac';
                warning.classList.add('hidden');
                ytLinkBtn?.classList.toggle('linked', Boolean(data.youtubeLinked));
                if (data.youtubeLinked && !currentChannelData) loadChannelData(false);
            } else {
                badge.innerHTML = '<span class="status-dot error"></span> Key Missing';
                badge.style.color = '#fca5a5';
                warning.classList.remove('hidden');
            }
        } catch { badge.innerHTML = '<span class="status-dot error"></span> Offline'; badge.style.color = '#fca5a5'; }
    }
    checkApiStatus();

    // ── Exports ───────────────────────────────────────────────────────────────
    exportPdfBtn.addEventListener('click', exportPDF);
    exportJsonBtn.addEventListener('click', exportJSON);
    exportTxtBtn.addEventListener('click', exportTXT);

    function exportJSON() {
        if (!lastResultData) { alert('No data.'); return; }
        const blob = new Blob([JSON.stringify(lastResultData, null, 2)], { type: 'application/json' });
        downloadBlob(blob, 'YT_Analyzer_Report.json');
    }

    function exportTXT() {
        if (!lastResultData) { alert('No data.'); return; }
        const d = lastResultData;
        const lines = [
            '═══════════════════════════════════════════════',
            '     YT ANALYZER PRO — ANALYSIS REPORT        ',
            '═══════════════════════════════════════════════',
            `Overall Score: ${d.rating}/10   Views Potential: ${d.viewsPotential}`,
            `Generated: ${new Date().toLocaleString()}`,
            '',
            '── FEEDBACK ────────────────────────────────────',
            `Visual: ${d.feedback?.visualQuality || ''}`,
            `Audio: ${d.feedback?.audioQuality || ''}`,
            `Hook: ${d.feedback?.hook || ''}`,
            `Editing: ${d.feedback?.editingStyle || ''}`,
            '',
            '── VIRAL SCORES ────────────────────────────────',
            `Overall: ${d.viralScore?.overall}  Entertainment: ${d.viralScore?.entertainment}  Watchability: ${d.viralScore?.watchability}`,
            `Shareability: ${d.viralScore?.shareability}  Engagement: ${d.viralScore?.engagementPotential}`,
            '',
            '── NICHE ───────────────────────────────────────',
            `Primary: ${d.nicheDetector?.primaryNiche}  Secondary: ${d.nicheDetector?.secondaryNiche}`,
            '',
            '── MONETIZATION ────────────────────────────────',
            `CPM: ${d.monetizationScore?.cpmPotential}  Revenue: ${d.monetizationScore?.revenueEstimate}`,
            '',
            '── COPYRIGHT RISK ──────────────────────────────',
            `Overall: ${d.copyrightRisk?.overallRisk}  Music: ${d.copyrightRisk?.musicRisk}  Visual: ${d.copyrightRisk?.visualRisk}`,
            '',
            '── TRANSCRIPT ──────────────────────────────────',
            d.transcript || 'N/A',
            '',
            '── SUMMARY ─────────────────────────────────────',
            d.automaticSummary?.shortSummary || 'N/A',
            '',
            '── TITLES ──────────────────────────────────────',
            ...(d.metadata?.titles?.english || []).map((t, i) => `EN ${i+1}: ${t}`),
            ...(d.metadata?.titles?.hindi || []).map((t, i) => `HI ${i+1}: ${t}`),
            '',
            '── AI VIDEO COACH ──────────────────────────────',
            d.aiVideoCoach?.overallAssessment || 'N/A',
            '',
            '── GROWTH PREDICTIONS ──────────────────────────',
            `Worst: ${d.growthPrediction?.worstCase}  Average: ${d.growthPrediction?.averageCase}  Best: ${d.growthPrediction?.bestCase}`,
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        downloadBlob(blob, 'YT_Analyzer_Report.txt');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
    }

    function exportPDF() {
        if (!lastResultData) { alert('No analysis data to export.'); return; }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        const data = lastResultData;
        const pageH = 280; const margin = 15; const maxW = 180; let y = 20;
        const addText = (text, size = 10, bold = false, color = [220, 220, 220]) => {
            if (y > pageH) { doc.addPage(); y = 20; }
            doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setTextColor(...color);
            const lines = doc.splitTextToSize(String(text || ''), maxW);
            doc.text(lines, margin, y); y += lines.length * 7;
        };
        const addSection = (title) => { y += 3; if (y > pageH) { doc.addPage(); y = 20; } doc.setFillColor(30,30,50); doc.rect(margin-2, y-5, maxW+4, 9, 'F'); addText(title, 12, true, [160,100,255]); y += 2; };
        doc.setFillColor(18, 18, 30); doc.rect(0, 0, 210, 297, 'F');
        addText('YT Analyzer Pro — Full AI Report', 18, true, [160, 100, 255]);
        addText(`Score: ${data.rating}/10 · Potential: ${data.viewsPotential} · ${new Date().toLocaleString()}`, 10, false, [200, 200, 200]);
        y += 5;
        addSection('🎯 Niche & Monetization');
        addText(`Niche: ${data.nicheDetector?.primaryNiche} / ${data.nicheDetector?.secondaryNiche} (${data.nicheDetector?.confidence}% confident)`);
        addText(`CPM: ${data.monetizationScore?.cpmPotential} · Revenue: ${data.monetizationScore?.revenueEstimate}`);
        addSection('📊 Viral & Algorithm Scores');
        if (data.viralScore) { const vs = data.viralScore; addText(`Overall: ${vs.overall} | Entertainment: ${vs.entertainment} | Watchability: ${vs.watchability} | Shareability: ${vs.shareability} | Engagement: ${vs.engagementPotential}`); }
        addSection('🔥 Hook & Retention');
        if (data.hookAnalysis) { addText(`Hook Rating: ${data.hookAnalysis.rating}/10`); addText(data.hookAnalysis.hookText || ''); addText(`Retention: ${data.hookAnalysis.retentionPrediction || ''}`); }
        addSection('📝 Summary');
        addText(data.automaticSummary?.shortSummary || 'N/A');
        addSection('🎬 AI Video Coach');
        addText(data.aiVideoCoach?.overallAssessment || 'N/A');
        (data.aiVideoCoach?.topMistakes || []).forEach((m, i) => addText(`${i+1}. ${m}`));
        addSection('📈 Growth & Subscriber Predictions');
        addText(`Views — Worst: ${data.growthPrediction?.worstCase} · Avg: ${data.growthPrediction?.averageCase} · Best: ${data.growthPrediction?.bestCase}`);
        addText(`Subscribers — 30d: ${data.subscriberGrowthPrediction?.thirtyDay} · 90d: ${data.subscriberGrowthPrediction?.ninetyDay} · 1yr: ${data.subscriberGrowthPrediction?.oneYear}`);
        addSection('🏷️ Titles');
        (data.metadata?.titles?.english || []).forEach((t, i) => addText(`EN ${i+1}: ${t}`));
        (data.metadata?.titles?.hindi || []).forEach((t, i) => addText(`HI ${i+1}: ${t}`));
        addSection('🛡️ Safety Checks');
        addText(`Copyright: ${data.copyrightRisk?.overallRisk} · Community Guidelines: ${data.communityGuidelineRisk?.riskLevel} · Demonetization: ${data.communityGuidelineRisk?.demonetizationRisk}`);
        addSection('💬 Transcript');
        addText((data.transcript || 'N/A').substring(0, 800));
        doc.save('YT_Analyzer_Pro_Report.pdf');
    }

    // ── New Analysis ──────────────────────────────────────────────────────────
    newAnalysisBtn.addEventListener('click', () => {
        if (pollInterval) clearInterval(pollInterval);
        currentFile = null; currentJobId = null; chatHistory = [];
        fileInput.value = '';
        videoPreview.src = '';
        document.getElementById('thumbnail-img').src = '';
        document.getElementById('thumbnail-download-link').href = '';
        document.getElementById('algo-ctr-fill').style.width = '0%';
        document.getElementById('algo-ctr-val').innerText = '0%';
        document.getElementById('algo-hook-fill').style.width = '0%';
        document.getElementById('algo-hook-val').innerText = '0%';
        processingCard.classList.add('hidden');
        resultsDashboard.classList.add('hidden');
        uploadCard.classList.remove('hidden');
    });

    // ── Viral Score Ring ──────────────────────────────────────────────────────
    function renderViralScore(elId, score) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.innerText = score;
        const parent = el.closest('.vscore-ring');
        if (!parent) return;
        const color = score >= 75 ? '#4ade80' : score >= 50 ? '#facc15' : '#f87171';
        parent.style.background = `conic-gradient(${color} ${score * 3.6}deg, rgba(255,255,255,0.07) 0deg)`;
        parent.style.color = color;
    }

    // ── Content Badges ────────────────────────────────────────────────────────
    function renderContentBadges(data) {
        const grid = document.getElementById('content-badges-grid');
        grid.innerHTML = '';
        const addBadge = (icon, label, value, color) => {
            const div = document.createElement('div');
            div.className = 'content-badge';
            div.style.borderColor = color + '40';
            div.innerHTML = `<i class="${icon}" style="color:${color}"></i><div class="badge-info"><span class="badge-label">${label}</span><span class="badge-val" style="color:${color}">${value}</span></div>`;
            grid.appendChild(div);
        };
        if (data.emotionAnalysis) { const ec = { funny:'#facc15', sad:'#60a5fa', motivational:'#4ade80', exciting:'#f97316' }; addBadge('fa-solid fa-masks-theater', 'Emotion', data.emotionAnalysis.primaryEmotion || 'N/A', ec[(data.emotionAnalysis.primaryEmotion||'').toLowerCase()] || '#a78bfa'); }
        if (data.profanityDetection) addBadge('fa-solid fa-shield-halved', 'Content Safe', data.profanityDetection.isClean ? 'Family Safe ✅' : 'Flagged ⚠️', data.profanityDetection.isClean ? '#4ade80' : '#f87171');
        if (data.shortsAnalysis) addBadge('fa-solid fa-mobile-screen', 'Shorts Fit', data.shortsAnalysis.isSuitable ? 'Yes ✅' : 'No ❌', data.shortsAnalysis.isSuitable ? '#4ade80' : '#f87171');
        if (data.hookAnalysis) { const hr = data.hookAnalysis.rating || 0; addBadge('fa-solid fa-bolt', 'Hook', `${hr}/10`, hr >= 7 ? '#4ade80' : hr >= 5 ? '#facc15' : '#f87171'); }
        if (data.nicheDetector) addBadge('fa-solid fa-crosshairs', 'Niche', data.nicheDetector.primaryNiche || 'N/A', '#60a5fa');
        if (data.monetizationScore) addBadge('fa-solid fa-dollar-sign', 'CPM', data.monetizationScore.cpmPotential?.split(' ')[0] || 'N/A', '#4ade80');
        if (data.copyrightRisk) { const rr = data.copyrightRisk.overallRisk; addBadge('fa-solid fa-shield-check', 'Copyright', rr || 'N/A', rr === 'Low' ? '#4ade80' : rr === 'Medium' ? '#facc15' : '#f87171'); }
        if (data.sponsorOpportunityScore) { const ss = data.sponsorOpportunityScore.score || 0; addBadge('fa-solid fa-handshake', 'Sponsor', `${ss}/100`, ss >= 70 ? '#4ade80' : '#facc15'); }
    }

    // ── Quick Stats Widget ────────────────────────────────────────────────────
    function renderQuickStats(data) {
        const grid = document.getElementById('quick-stats-grid');
        grid.innerHTML = '';
        const addStat = (icon, label, val, color) => {
            const div = document.createElement('div');
            div.className = 'quick-stat-item';
            div.innerHTML = `<i class="fa-solid ${icon}" style="color:${color}"></i><div><span class="qs-val" style="color:${color}">${val}</span><span class="qs-label">${label}</span></div>`;
            grid.appendChild(div);
        };
        if (data.hookAnalysis) addStat('fa-bolt', 'Hook', `${data.hookAnalysis.rating}/10`, '#facc15');
        if (data.memePotential) addStat('fa-icons', 'Meme', `${data.memePotential.score}/100`, '#f97316');
        if (data.humorAnalysis) addStat('fa-face-laugh', 'Humor', `${data.humorAnalysis.funniness}/100`, '#a78bfa');
        if (data.visualQualityDetailed) addStat('fa-camera', 'Visual', `${data.visualQualityDetailed.score}/100`, '#60a5fa');
        if (data.audioQualityDetailed) addStat('fa-headphones', 'Audio', `${data.audioQualityDetailed.clarityScore}/100`, '#4ade80');
        if (data.aiImprovementScore) addStat('fa-chart-line', 'Potential', `${data.aiImprovementScore.potentialScore}/100`, '#ec4899');
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function setText(id, val) {
        const el = document.getElementById(id);
        if (!el) return;
        const shouldFormat = el.classList.contains('feedback-text')
            || el.classList.contains('section-hint')
            || el.classList.contains('algo-feedback')
            || id.toLowerCase().includes('reasoning')
            || id.toLowerCase().includes('strategy');
        if (shouldFormat) el.innerHTML = formatCompactText(val || '');
        else el.innerText = val || '';
    }
    function updateProgress(pct) { progressFill.style.width = `${pct}%`; progressPercentage.innerText = `${pct}%`; }
    function addLog(message) {
        const ts = new Date().toLocaleTimeString();
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = `<span style="color:var(--text-muted)">[${ts}]</span> ${message}`;
        logsBody.appendChild(div);
        logsBody.scrollTop = logsBody.scrollHeight;
    }
    function handleError(message) { alert(`Error: ${message}`); resetDashboard(); }
    function resetDashboard() {
        if (pollInterval) clearInterval(pollInterval);
        currentFile = null; currentJobId = null; chatHistory = [];
        fileInput.value = '';
        processingCard.classList.add('hidden');
        resultsDashboard.classList.add('hidden');
        uploadCard.classList.remove('hidden');
    }

    function setBar(fillId, valId, value, suffix = '') {
        const fillEl = document.getElementById(fillId);
        const valEl = document.getElementById(valId);
        if (fillEl) fillEl.style.width = `${value}%`;
        if (valEl) valEl.innerText = `${value}${suffix}`;
    }

    function renderList(containerId, items) {
        const ul = document.getElementById(containerId);
        if (!ul) return;
        ul.innerHTML = '';
        items.forEach(item => {
            const li = document.createElement('li');
            li.innerText = compactLine(typeof item === 'string' ? item : JSON.stringify(item));
            ul.appendChild(li);
        });
    }

    function escapeHtml(value = '') {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function compactLine(value = '') {
        const text = String(value).replace(/\s+/g, ' ').trim();
        return text.length > 210 ? `${text.slice(0, 207).trim()}...` : text;
    }

    function splitCompactPoints(value = '') {
        const text = String(value).replace(/\r/g, '\n').trim();
        if (!text) return [];
        const lines = text.split(/\n+/).map(line => line.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean);
        if (lines.length > 1) return lines.map(compactLine);
        return text
            .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
            .map(compactLine)
            .filter(Boolean)
            .slice(0, 5);
    }

    function formatCompactText(value = '') {
        const points = splitCompactPoints(value);
        if (!points.length) return '';
        if (points.length === 1) return escapeHtml(points[0]);
        return `<ul class="compact-points">${points.map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul>`;
    }

    function formatChatText(value = '') {
        const text = String(value).trim();
        if (!text) return '';
        const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
        if (lines.length <= 1) return formatCompactText(text);
        return `<ul class="compact-points chat-points">${lines.map(line => `<li>${escapeHtml(line.replace(/^[-*•\d.)\s]+/, ''))}</li>`).join('')}</ul>`;
    }

    function formatNumber(value) {
        const num = Number(value || 0);
        if (num >= 10000000) return `${(num / 10000000).toFixed(num >= 100000000 ? 0 : 1)}Cr`;
        if (num >= 100000) return `${(num / 100000).toFixed(num >= 1000000 ? 0 : 1)}L`;
        if (num >= 1000) return `${(num / 1000).toFixed(num >= 10000 ? 0 : 1)}K`;
        return String(num);
    }

    function renderTagPills(containerId, items, isHashtag) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        items.forEach(item => {
            const tagStr = typeof item === 'string' ? item : item.tag;
            const rankVal = typeof item === 'string' ? null : item.rank;
            const pill = document.createElement('span');
            pill.className = 'tag-pill' + (isHashtag ? '' : ' secondary');
            pill.innerHTML = isHashtag
                ? `<i class="fa-solid fa-hashtag"></i> ${tagStr.replace('#','')}${rankVal ? `<span style="font-size:0.7rem;background:rgba(255,255,255,0.15);padding:0.1rem 0.35rem;border-radius:4px;margin-left:0.4rem;font-weight:700;">${rankVal}%</span>` : ''}`
                : tagStr;
            pill.onclick = () => copyRawText(tagStr);
            container.appendChild(pill);
        });
    }

    function renderTimestampList(containerId, items, prefix, color) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'broll-item';
            div.innerHTML = `<span class="broll-ts" style="color:${color};background:${color}15;">${item.timestamp || item.ts || '–'}</span><span class="broll-text">${prefix}: ${item.note || item.description || item.suggestion || ''}</span>`;
            el.appendChild(div);
        });
    }

    function renderTimestampDescription(containerId, items) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'chapter-item';
            const ts = item.timestamp || item.ts || '–';
            const desc = item.description || item.title || item.significance || '';
            div.innerHTML = `<span class="chapter-ts">${ts}</span><span class="chapter-title">${desc}</span>`;
            el.appendChild(div);
        });
    }

    function renderTimestampScore(containerId, items) {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'broll-item';
            const score = item.interestScore;
            const scoreColor = score >= 85 ? '#4ade80' : score >= 60 ? '#facc15' : '#f87171';
            div.innerHTML = `<span class="broll-ts">${item.timestamp}</span><span class="broll-text">${item.description}${score ? ` <span style="color:${scoreColor};font-weight:700;margin-left:0.5rem;">${score}%</span>` : ''}</span>`;
            el.appendChild(div);
        });
    }

    function getFlagEmoji(country) {
        const flags = { 'India':'🇮🇳','USA':'🇺🇸','UK':'🇬🇧','Canada':'🇨🇦','Australia':'🇦🇺','Germany':'🇩🇪','France':'🇫🇷','Brazil':'🇧🇷' };
        return flags[country] || '🌍';
    }
});

// ── Global Clipboard ──────────────────────────────────────────────────────────
window.copySpecificTitle = function(index) {
    const el = document.getElementById(`title-text-${index}`);
    if (el) copyRawText(el.innerText);
};
window.copyText = function(elementId) {
    const el = document.getElementById(elementId);
    if (el) copyRawText(el.value || el.innerText);
};
window.copyRawText = function(text) {
    navigator.clipboard.writeText(text).then(() => {
        const toast = document.getElementById('toast');
        toast.classList.remove('hidden');
        toast.classList.add('show');
        setTimeout(() => { toast.classList.remove('show'); }, 2200);
    });
};

// ═══════════════════════════════════════════════════════════════
//  AI EDIT STUDIO MODULE
// ═══════════════════════════════════════════════════════════════
(function StudioModule() {
    const studioOverlay     = document.getElementById('studio-overlay');
    const studioModal       = document.getElementById('studio-modal');
    const studioOpenBtn     = document.getElementById('studio-tab-btn') || document.getElementById('studio-open-btn');
    const studioCloseBtn    = document.getElementById('studio-close-btn');
    const studioNavBtns     = document.querySelectorAll('.studio-nav-btn');
    const studioTabPanels   = document.querySelectorAll('.studio-tab-panel');

    const promptTextarea    = document.getElementById('studio-prompt-textarea');
    const generateBtn       = document.getElementById('studio-generate-btn');
    const voiceBtn          = document.getElementById('studio-voice-btn');
    const exampleChips      = document.querySelectorAll('.studio-example-chip');
    const refreshExamples   = document.getElementById('studio-refresh-examples');
    const inspirationBtn    = document.getElementById('studio-inspiration-btn');

    const orbitContainer    = document.getElementById('studio-orbit-container');
    const generatingDiv     = document.getElementById('studio-generating');
    const resultDiv         = document.getElementById('studio-result');
    const resultBody        = document.getElementById('studio-result-body');
    const genSteps          = document.querySelectorAll('.studio-gen-step');

    const videoPlayer       = document.getElementById('studio-video-player');
    const downloadBtn       = document.getElementById('studio-download-btn');
    const copyBtn           = document.getElementById('studio-copy-btn');
    const regenerateBtn     = document.getElementById('studio-regenerate-btn');

    const chatMessages      = document.getElementById('studio-chat-messages');
    const chatInput         = document.getElementById('studio-chat-input');
    const chatSend          = document.getElementById('studio-chat-send');
    const chatChips         = document.querySelectorAll('.studio-chat-chip');

    const creditsVal        = document.getElementById('studio-credits-val');
    const creditsPillVal    = document.getElementById('studio-credits-pill-val');
    const creditsFill       = document.getElementById('studio-credits-fill');

    let studioCredits = 20;
    let studioHistory = [];
    let currentPrompt = '';
    let isGenerating = false;
    let recognition = null;
    let currentVideoUrl = '';
    let currentEdits = { filter: 'none', speed: 1.0, textOverlay: '', audioEffect: 'none' };
    let statusTextLog = '';

    // ── Open / Close ──
    if (studioOpenBtn) studioOpenBtn.addEventListener('click', openStudio);
    if (studioCloseBtn) studioCloseBtn.addEventListener('click', closeStudio);
    if (studioOverlay) studioOverlay.addEventListener('click', closeStudio);

    function openStudio() {
        if (!studioModal || !studioOverlay) return;
        studioModal.classList.remove('hidden');
        studioOverlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        // Load current video or fallback
        if (window.lastStudioVideoPath) {
            videoPlayer.src = window.lastStudioVideoPath;
        }

        populateIdeasTab();
        populateOptimizeTab();
    }

    function closeStudio() {
        if (!studioModal || !studioOverlay) return;
        studioModal.classList.add('hidden');
        studioOverlay.classList.add('hidden');
        document.body.style.overflow = '';
        videoPlayer.pause();
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !studioModal?.classList.contains('hidden')) closeStudio();
    });

    // ── Sidebar Navigation ──
    studioNavBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-studio-tab');
            if (!target) return;
            studioNavBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            studioTabPanels.forEach(p => {
                p.classList.toggle('active', p.id === target);
            });
        });
    });

    // ── Credits display ──
    function updateCredits(val) {
        studioCredits = Math.max(0, val);
        if (creditsVal) creditsVal.textContent = studioCredits;
        if (creditsPillVal) creditsPillVal.textContent = studioCredits;
        if (creditsFill) creditsFill.style.width = `${(studioCredits / 20) * 100}%`;
    }
    updateCredits(20);

    // ── Example chips ──
    exampleChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const p = chip.getAttribute('data-prompt');
            if (p && promptTextarea) {
                promptTextarea.value = p;
                promptTextarea.focus();
            }
        });
    });

    // ── Refresh examples rotation ──
    const extraExamples = [
        { icon: 'fa-solid fa-fire', label: 'Viral reaction edit', prompt: 'Make it a fast reaction short with grayscale filter and speed up pacing to 1.5x speed' },
        { icon: 'fa-solid fa-video', label: 'Vintage cinematic grade', prompt: 'Vintage film look with vignette and dramatic contrast filter' },
        { icon: 'fa-solid fa-dumbbell', label: 'High energy music beat', prompt: 'High energy speed up edit at 1.25x speed with bass boosted audio' },
        { icon: 'fa-solid fa-tag', label: 'Bold title card text', prompt: 'Add bold banner caption title overlay saying BEAST MODE ON' }
    ];
    let exampleSet = 0;
    if (refreshExamples) {
        refreshExamples.addEventListener('click', () => {
            exampleSet = (exampleSet + 1) % 2;
            const grid = document.getElementById('studio-examples-grid');
            if (!grid) return;
            if (exampleSet === 1) {
                grid.innerHTML = extraExamples.map(e =>
                    `<button class="studio-example-chip" data-prompt="${e.prompt}"><i class="${e.icon}"></i> ${e.label}</button>`
                ).join('');
                grid.querySelectorAll('.studio-example-chip').forEach(c => {
                    c.addEventListener('click', () => {
                        if (promptTextarea) promptTextarea.value = c.getAttribute('data-prompt');
                    });
                });
            } else {
                location.reload();
            }
        });
    }

    // ── Inspiration Button ──
    const inspirations = [
        'Apply a high contrast filter and overlay BEAST MODE caption',
        'Convert to grayscale and speed up the pacing to 1.25x speed',
        'Add a cinematic vintage LUT grade overlay with bass boost audio',
        'Sync edit with sepia filter tone and speed up transitions to 1.5x'
    ];
    if (inspirationBtn) {
        inspirationBtn.addEventListener('click', () => {
            const r = inspirations[Math.floor(Math.random() * inspirations.length)];
            if (promptTextarea) { promptTextarea.value = r; promptTextarea.focus(); }
        });
    }

    // ── Voice Input ──
    if (voiceBtn) {
        voiceBtn.addEventListener('click', () => {
            if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
                alert('Voice input not supported in this browser. Please use Chrome.');
                return;
            }
            if (recognition) { recognition.stop(); recognition = null; voiceBtn.classList.remove('recording'); return; }
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            recognition = new SR();
            recognition.lang = 'en-US';
            recognition.interimResults = false;
            voiceBtn.classList.add('recording');
            recognition.start();
            recognition.onresult = e => {
                const transcript = e.results[0][0].transcript;
                if (promptTextarea) promptTextarea.value = transcript;
                voiceBtn.classList.remove('recording');
                recognition = null;
            };
            recognition.onerror = recognition.onend = () => {
                voiceBtn.classList.remove('recording');
                recognition = null;
            };
        });
    }

    // ── Show states ──
    function showOrbit() {
        orbitContainer?.classList.remove('hidden');
        generatingDiv?.classList.add('hidden');
        resultDiv?.classList.add('hidden');
    }

    function showGenerating() {
        orbitContainer?.classList.add('hidden');
        generatingDiv?.classList.remove('hidden');
        resultDiv?.classList.add('hidden');
    }

    function showResult() {
        orbitContainer?.classList.add('hidden');
        generatingDiv?.classList.add('hidden');
        resultDiv?.classList.remove('hidden');
    }

    async function animatePlanSteps(steps) {
        const container = document.getElementById('studio-gen-steps');
        if (!container) return;
        
        container.innerHTML = steps.map((s, i) => `
            <div class="studio-gen-step" id="dynamic-step-${i}">
                <i class="fa-solid fa-circle-notch" style="margin-right:8px;opacity:0.5;"></i> ${s.stepName}
            </div>
        `).join('');

        for (let i = 0; i < steps.length; i++) {
            const el = document.getElementById(`dynamic-step-${i}`);
            if (el) {
                el.classList.add('active');
                el.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="color:#a78bfa;margin-right:8px;"></i> ${steps[i].stepName}`;
                await new Promise(r => setTimeout(r, 900));
                el.classList.remove('active');
                el.classList.add('done');
                el.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981;margin-right:8px;"></i> ${steps[i].stepName}`;
            }
        }
    }

    // ── Generate Plan ──
    if (generateBtn) generateBtn.addEventListener('click', generateVideoEdit);
    if (promptTextarea) {
        promptTextarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && e.ctrlKey) generateVideoEdit();
        });
    }

    async function generateVideoEdit() {
        const prompt = promptTextarea?.value?.trim();
        if (!prompt) { promptTextarea?.focus(); return; }
        if (isGenerating) return;
        if (studioCredits <= 0) { alert('No credits left. Credits reset each session.'); return; }
        if (!window.lastStudioVideoPath) { alert('Please analyze a video first.'); return; }

        isGenerating = true;
        currentPrompt = prompt;
        generateBtn.disabled = true;
        showGenerating();

        // 1. Initial Planning Step
        const container = document.getElementById('studio-gen-steps');
        if (container) {
            container.innerHTML = `
                <div class="studio-gen-step active">
                    <i class="fa-solid fa-brain fa-spin" style="color:#a78bfa;margin-right:8px;"></i> Manus AI is planning your editing steps...
                </div>
            `;
        }

        const videoCtx = window.lastStudioContext || null;
        const videoName = window.lastStudioVideoName || 'My Video';

        try {
            // Call Planning Endpoint
            const planResponse = await fetch('/api/studio/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    videoContext: videoCtx,
                    videoName
                })
            });

            const planJson = await planResponse.json();
            if (!planResponse.ok || !planJson.success) {
                throw new Error(planJson.error || 'Planning failed.');
            }

            const plannedSteps = planJson.steps;
            const plannedSummary = planJson.summary;

            // Render dynamic steps
            const animationPromise = animatePlanSteps(plannedSteps);

            // 2. Call Execution Endpoint (concurrently)
            const executeResponse = await fetch('/api/studio/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    steps: plannedSteps,
                    videoPath: window.lastStudioVideoPath
                })
            });

            const execJson = await executeResponse.json();
            if (!executeResponse.ok || !execJson.success) {
                throw new Error(execJson.error || 'Execution failed.');
            }

            // Await animation completion so the user gets the full experience
            await animationPromise;

            currentVideoUrl = execJson.editedVideoUrl;
            currentEdits = plannedSteps;
            statusTextLog = plannedSummary;
            studioHistory = [];
            chatMessages.innerHTML = '';
            
            // Load and play edited video
            videoPlayer.src = currentVideoUrl;
            videoPlayer.load();
            videoPlayer.play().catch(e => console.log('Auto-play blocked by browser.'));

            // Setup download link
            downloadBtn.href = currentVideoUrl;

            // Render status logs with premium badges
            if (resultBody) {
                const badges = currentEdits.map(s => `
                    <span style="display:inline-flex;align-items:center;background:rgba(124,58,237,0.15);color:#c4b5fd;border:1px solid rgba(124,58,237,0.3);padding:0.25rem 0.6rem;border-radius:20px;font-size:0.75rem;font-weight:600;gap:4px;margin-bottom:4px;">
                        <i class="fa-solid fa-circle-check" style="color:#10b981;"></i> ${s.stepName}
                    </span>
                `).join(' ');

                resultBody.innerHTML = `
                    <div style="font-weight:700;color:#c4b5fd;margin-bottom:0.4rem;"><i class="fa-solid fa-circle-info"></i> Manus AI Agent Log</div>
                    <p style="margin:0 0 0.5rem 0;color:#e5e7eb;font-size:0.8rem;line-height:1.45;">${statusTextLog}</p>
                    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.4rem;">
                        ${badges}
                    </div>`;
            }

            updateCredits(studioCredits - 1);
            showResult();

        } catch (err) {
            showOrbit();
            alert(`Error running FFmpeg edit: ${err.message}`);
        } finally {
            isGenerating = false;
            if (generateBtn) generateBtn.disabled = false;
        }
    }

    // ── Copy / Refine / Regenerate ──
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            if (statusTextLog) {
                navigator.clipboard.writeText(statusTextLog);
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                setTimeout(() => { copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 2000);
            }
        });
    }

    if (regenerateBtn) {
        regenerateBtn.addEventListener('click', () => {
            if (currentPrompt) { promptTextarea.value = currentPrompt; generateVideoEdit(); }
        });
    }

    // ── Studio Chat Refinements ──
    if (chatSend) chatSend.addEventListener('click', sendStudioChatRefine);
    if (chatInput) {
        chatInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendStudioChatRefine(); }
        });
    }
    chatChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const msg = chip.getAttribute('data-msg');
            if (msg && chatInput) { chatInput.value = msg; sendStudioChatRefine(); }
        });
    });

    async function sendStudioChatRefine() {
        const msg = chatInput?.value?.trim();
        if (!msg || !currentVideoUrl) return;
        chatInput.value = '';

        appendStudioChat('user', msg);
        studioHistory.push({ role: 'user', content: msg });

        // Show inline typing indicator
        const typingEl = document.createElement('div');
        typingEl.className = 'studio-chat-msg';
        typingEl.innerHTML = `
            <div class="studio-chat-avatar"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            <div class="studio-chat-bubble" style="min-width:60px;padding:0.4rem 0.65rem;">
                <span style="display:flex;gap:4px;align-items:center;padding:0.1rem 0;">
                    <span style="width:5px;height:5px;border-radius:50%;background:#a78bfa;animation:typingDot 1.2s infinite;"></span>
                    <span style="width:5px;height:5px;border-radius:50%;background:#a78bfa;animation:typingDot 1.2s 0.2s infinite;"></span>
                    <span style="width:5px;height:5px;border-radius:50%;background:#a78bfa;animation:typingDot 1.2s 0.4s infinite;"></span>
                </span>
            </div>`;
        chatMessages?.appendChild(typingEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        try {
            // Stage 1: Call plan refinement endpoint
            const planResp = await fetch('/api/studio/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: msg,
                    videoContext: window.lastStudioContext || null,
                    currentEdits: currentEdits,
                    isRefine: true,
                    history: studioHistory.slice(-8)
                })
            });

            const planJson = await planResp.json();
            if (!planResp.ok || !planJson.success) throw new Error(planJson.error || 'Planning failed');

            const plannedSteps = planJson.steps;
            const plannedSummary = planJson.summary;

            // Stage 2: Execute new steps
            const execResp = await fetch('/api/studio/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    steps: plannedSteps,
                    videoPath: window.lastStudioVideoPath
                })
            });

            const execJson = await execResp.json();
            typingEl.remove();

            if (!execResp.ok || !execJson.success) throw new Error(execJson.error || 'Execution failed');

            currentVideoUrl = execJson.editedVideoUrl;
            currentEdits = plannedSteps;
            statusTextLog = plannedSummary;

            // Load new edited video
            videoPlayer.src = currentVideoUrl;
            videoPlayer.load();
            videoPlayer.play().catch(e => {});

            // Update download button
            downloadBtn.href = currentVideoUrl;

            // Update log box with dynamic badges
            if (resultBody) {
                const badges = currentEdits.map(s => `
                    <span style="display:inline-flex;align-items:center;background:rgba(124,58,237,0.15);color:#c4b5fd;border:1px solid rgba(124,58,237,0.3);padding:0.25rem 0.6rem;border-radius:20px;font-size:0.75rem;font-weight:600;gap:4px;margin-bottom:4px;">
                        <i class="fa-solid fa-circle-check" style="color:#10b981;"></i> ${s.stepName}
                    </span>
                `).join(' ');

                resultBody.innerHTML = `
                    <div style="font-weight:700;color:#c4b5fd;margin-bottom:0.4rem;"><i class="fa-solid fa-circle-info"></i> Manus AI Edit Log (Refined)</div>
                    <p style="margin:0 0 0.5rem 0;color:#e5e7eb;font-size:0.8rem;line-height:1.45;">${statusTextLog}</p>
                    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.4rem;">
                        ${badges}
                    </div>`;
            }

            appendStudioChat('ai', statusTextLog);
            studioHistory.push({ role: 'assistant', content: statusTextLog });

        } catch (err) {
            typingEl.remove();
            appendStudioChat('ai', `Edit failed: ${err.message}`);
        }
    }

    function appendStudioChat(role, text) {
        if (!chatMessages) return;
        const div = document.createElement('div');
        div.className = `studio-chat-msg${role === 'user' ? ' studio-user-msg' : ''}`;
        const icon = role === 'user' ? '<i class="fa-solid fa-user"></i>' : '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        const bubbleText = text.replace(/\n/g, '<br>');
        div.innerHTML = `
            <div class="studio-chat-avatar">${icon}</div>
            <div class="studio-chat-bubble">${bubbleText}</div>`;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ── Populate Ideas tab from video analysis ──
    function populateIdeasTab() {
        const grid = document.getElementById('studio-ideas-grid');
        if (!grid) return;
        const ctx = window.lastStudioContext;
        if (!ctx) {
            grid.innerHTML = `<div class="studio-idea-card">
                <i class="fa-solid fa-lightbulb"></i>
                <div><div class="studio-idea-title">Analyze a video first</div>
                <div class="studio-idea-desc">Analyze a video to get personalized edit ideas based on your content.</div></div>
            </div>`;
            return;
        }
        const editStyle = ctx.feedback?.editingStyle || '';
        const viralScore = ctx.viralScore?.overall || 0;
        const hookScore = ctx.hookAnalysis?.rating || 0;
        const ideas = [
            { icon: 'fa-fire', title: 'Viral Short Remix', desc: `Based on your ${viralScore}/100 viral score — condense the best 45 seconds with beat-synced cuts.` },
            { icon: 'fa-palette', title: 'Cinema Color Grade', desc: 'Apply cinematic LUT with warm shadows and teal highlights for premium feel.' },
            { icon: 'fa-bolt', title: 'Hook Booster Edit', desc: `Your hook scored ${hookScore}/10. Restructure opening 5 seconds with a stronger visual punch.` },
            { icon: 'fa-music', title: 'Music Sync Edit', desc: 'Auto-cut to beat drops and transitions synced to background music rhythm.' },
            { icon: 'fa-closed-captioning', title: 'Caption Explosion', desc: 'Add animated word-by-word captions in MrBeast style to boost watch time.' }
        ];
        grid.innerHTML = ideas.map(idea => `
            <div class="studio-idea-card" onclick="document.getElementById('studio-prompt-textarea').value='${idea.desc.replace(/'/g, '')}';document.querySelector('.studio-nav-btn[data-studio-tab=studio-home]').click();">
                <i class="fa-solid ${idea.icon}"></i>
                <div>
                    <div class="studio-idea-title">${idea.title}</div>
                    <div class="studio-idea-desc">${idea.desc}</div>
                </div>
            </div>
        `).join('');
    }

    // ── Populate Optimize tab ──
    function populateOptimizeTab() {
        const list = document.getElementById('studio-optimize-list');
        if (!list) return;
        const ctx = window.lastStudioContext;
        const tips = ctx?.feedback?.improvementSuggestions || [
            'Add jump cuts every 2-3 seconds to maintain viewer attention',
            'Use motion blur transitions between scenes for smoother flow',
            'Increase background music by 15-20% for emotional impact',
            'Add subtitle captions to boost watch time by up to 40%',
            'Use zoom-in effect on key talking points for emphasis'
        ];
        list.innerHTML = tips.slice(0, 6).map(tip => `
            <div class="studio-opt-item">
                <i class="fa-solid fa-circle-check"></i>
                <span>${tip}</span>
            </div>
        `).join('');
    }

    // ── Expose context setter for main app ──
    window.setStudioContext = function(resultData, videoName) {
        window.lastStudioContext = resultData;
        window.lastStudioVideoName = videoName || 'My Video';
    };

})();

