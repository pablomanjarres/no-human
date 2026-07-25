document.addEventListener('DOMContentLoaded', () => {
    
    // Mobile Menu Toggle
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const mainNav = document.querySelector('.main-nav');
    
    if(mobileMenuToggle && mainNav) {
        mobileMenuToggle.addEventListener('click', () => {
            mainNav.classList.toggle('active');
        });
    }

    // Cookie Banner
    const cookieBanner = document.getElementById('cookie-banner');
    const btnNecessary = document.getElementById('cookie-necessary');
    const btnAccept = document.getElementById('cookie-accept');
    
    if (!localStorage.getItem('sick_cookie_consent')) {
        setTimeout(() => {
            if(cookieBanner) cookieBanner.classList.add('show');
        }, 1000);
    }
    
    const dismissBanner = () => {
        if(cookieBanner) cookieBanner.classList.remove('show');
        localStorage.setItem('sick_cookie_consent', 'true');
    };

    if(btnNecessary) btnNecessary.addEventListener('click', dismissBanner);
    if(btnAccept) btnAccept.addEventListener('click', dismissBanner);

    // Smooth Scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const targetId = this.getAttribute('href');
            if(targetId === '#' || targetId.startsWith('#open-') || targetId.startsWith('#btn-')) return;
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });

    /* ==========================================================================
       NO-HUMAN 5-AGENT ENGINEERING ENGINE & DASHBOARD LOGIC
       ========================================================================== */

    // Elements
    const chatbotTrigger = document.getElementById('chatbot-trigger');
    const chatbotWidget = document.getElementById('chatbot-widget');
    const chatbotClose = document.getElementById('chatbot-close');
    const btnOpenDashboardNav = document.getElementById('open-dashboard-nav');
    const btnOpenDashboardHeader = document.getElementById('btn-open-dashboard');
    const agentsDashboardModal = document.getElementById('agents-dashboard-modal');
    const closeDashboardBtn = document.getElementById('close-dashboard-btn');
    
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');
    const chatReasoning = document.getElementById('chat-reasoning');
    const chatUploadBtn = document.getElementById('chat-upload-btn');
    
    const dashUserQuery = document.getElementById('dash-user-query');
    const dashThreadBody = document.getElementById('dash-thread-body');
    const reqChipsContainer = document.getElementById('req-chips-container');

    // Preset Knowledge Base Cases
    const engineeringCases = {
        keyence: {
            userText: "Tengo un Keyence LR-T5000 en línea de envasado. Quiero migrar a SICK con mejor resistencia IP67/IP69K.",
            intake: "Identificado reemplazo de sensor láser fotométrico Keyence LR-T5000 -> SICK Industrial Series.",
            reqs: [
                { label: "Distancia", val: "0.05 - 4.5 m" },
                { label: "Objeto", val: "Superficie oscura / metal" },
                { label: "Entorno", val: "IP67 / IP69K Lavado" },
                { label: "Salida", val: "PNP + IO-Link v1.1" },
                { label: "Velocidad", val: "< 1000 Hz" },
                { label: "Montaje", val: "M12 / M18 Roscado" }
            ],
            recommendation: {
                sku: "SICK W12G-3P2431 (Ref. 1041420)",
                desc: "Reemplazo 1:1 de alta inmunidad óptica con carcasa metálica de zinc fundido de precisión y certificación IP69K."
            },
            candidates: [
                { model: "W12G-3P2431", spec: "0.05 ... 4.5 m", ip: "IP69K", out: "PNP + IO-Link", adv: "Carcasa zinc autolimpiante", match: "100% (Pin M12)", rec: true },
                { model: "W4F-3P2221", spec: "0.01 ... 2.2 m", ip: "IP67", out: "Push-Pull", adv: "Ultra compacto", match: "90%", rec: false },
                { model: "DS50-P1121", spec: "0.2 ... 10 m", ip: "IP65", out: "4-20mA", adv: "Tecnología ToF", match: "80%", rec: false }
            ],
            challenger: [
                "⚠️ <strong>Condensación y lavado a alta presión:</strong> Si opera bajo cambios térmicos bruscos (>40°C delta), instalar la visera protectora con recubrimiento hidrófobo <strong>OB-W12</strong>.",
                "⚠️ <strong>Reflejo especular:</strong> Para recipientes metálicos pulidos con ángulo >15°, verificar la polarización del filtro óptico."
            ]
        },
        bottles: {
            userText: "Necesito detectar botellas de vidrio transparente a alta velocidad (15 m/s) sin falsos disparos por condensación.",
            intake: "Detección de objetos ultra-transparentes (vidrio/PET) en línea de envasado rápido.",
            reqs: [
                { label: "Distancia", val: "0.1 - 1.2 m" },
                { label: "Objeto", val: "Vidrio / PET Transparente" },
                { label: "Entorno", val: "Húmedo / Salpicaduras" },
                { label: "Salida", val: "PNP Ultra-fast" },
                { label: "Velocidad", val: "15 m/s (< 200µs)" },
                { label: "Montaje", val: "Soporte Ajustable" }
            ],
            recommendation: {
                sku: "SICK TranspaTect W4S-3P2232V",
                desc: "Sensor especializado para vidrio sin necesidad de reflector posterior. Utiliza el fondo de la cinta transportadora."
            },
            candidates: [
                { model: "W4S-3P2232V", spec: "0.01 ... 0.5 m", ip: "IP69K Stainless", out: "PNP", adv: "Auto-calibración continua", match: "100%", rec: true },
                { model: "VLG260-F280", spec: "0.05 ... 2.0 m", ip: "IP67", out: "IO-Link", adv: "Receptor multihilo", match: "88%", rec: false }
            ],
            challenger: [
                "⚠️ <strong>Inclinación de botellas:</strong> Botellas de cuello cónico pueden desviar el haz. Mantener haz a 90° de la superficie cilíndrica.",
                "⚠️ <strong>Acumulación de polvo de vidrio:</strong> Limpieza programada de lente autolimpiante."
            ]
        }
    };

    // Toggle Chatbot Window
    if(chatbotTrigger && chatbotWidget) {
        chatbotTrigger.addEventListener('click', () => {
            chatbotWidget.classList.toggle('active');
        });
    }

    if(chatbotClose && chatbotWidget) {
        chatbotClose.addEventListener('click', () => {
            chatbotWidget.classList.remove('active');
        });
    }

    // Toggle Dashboard Modal
    const openDashboard = () => {
        if(agentsDashboardModal) {
            agentsDashboardModal.classList.add('active');
            if(chatbotWidget) chatbotWidget.classList.remove('active');
        }
    };

    const closeDashboard = () => {
        if(agentsDashboardModal) agentsDashboardModal.classList.remove('active');
    };

    if(btnOpenDashboardNav) btnOpenDashboardNav.addEventListener('click', (e) => { e.preventDefault(); openDashboard(); });
    if(btnOpenDashboardHeader) btnOpenDashboardHeader.addEventListener('click', openDashboard);
    if(closeDashboardBtn) closeDashboardBtn.addEventListener('click', closeDashboard);

    // Upload attachment button simulation
    if(chatUploadBtn) {
        chatUploadBtn.addEventListener('click', () => {
            appendMessage('user', '📎 <em>[Archivo Adjunto]: datasheet_keyence_lrt.pdf (1.2 MB)</em>');
            run5AgentPipeline(engineeringCases.keyence);
        });
    }

    // Form Submit inside Chatbot
    if(chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = chatInput.value.trim();
            if(!text) return;
            
            chatInput.value = '';
            appendMessage('user', escapeHTML(text));

            if(text.toLowerCase().includes('keyence')) {
                run5AgentPipeline(engineeringCases.keyence);
            } else if(text.toLowerCase().includes('botella') || text.toLowerCase().includes('transparente')) {
                run5AgentPipeline(engineeringCases.bottles);
            } else {
                // Custom Case Generator
                const customCase = {
                    userText: text,
                    intake: `Entrada procesada: "${text}"`,
                    reqs: [
                        { label: "Distancia", val: "0.1 - 2.0 m" },
                        { label: "Objeto", val: "Industrial General" },
                        { label: "Entorno", val: "IP67" },
                        { label: "Salida", val: "PNP / IO-Link" },
                        { label: "Velocidad", val: "< 500 Hz" },
                        { label: "Montaje", val: "Estándar M18" }
                    ],
                    recommendation: {
                        sku: "SICK W16P-24161120A",
                        desc: "Sensor fotoeléctrico inteligente de alta precisión con tecnología TwinEye."
                    },
                    candidates: [
                        { model: "W16P-24161120A", spec: "0.02 ... 1.5 m", ip: "IP67", out: "IO-Link", adv: "TwinEye Technology", match: "98%", rec: true }
                    ],
                    challenger: [
                        "⚠️ <strong>Vibración de línea:</strong> Asegurar torque de montaje a 2.5 Nm con arandela de presión."
                    ]
                };
                run5AgentPipeline(customCase);
            }
        });
    }

    // Quick Chips Clicks
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('.quick-chip');
        if(chip) {
            const query = chip.getAttribute('data-query');
            if(query) {
                appendMessage('user', escapeHTML(query));
                if(query.includes('Keyence')) {
                    run5AgentPipeline(engineeringCases.keyence);
                } else if(query.includes('botellas')) {
                    run5AgentPipeline(engineeringCases.bottles);
                } else {
                    run5AgentPipeline(engineeringCases.keyence);
                }
            }
        }

        // Open Dashboard button inside chat message
        const btnOpenDashChat = e.target.closest('#btn-open-dash-chat');
        if(btnOpenDashChat) {
            openDashboard();
        }
    });

    // 5-AGENT SEQUENTIAL PIPELINE EXECUTION
    function run5AgentPipeline(caseData) {
        if(chatReasoning) chatReasoning.classList.remove('hidden');

        // Step 1: Intake Agent
        setTimeout(() => {
            // Step 2: Requirement Agent
            updateDashboardCase(caseData);
            
            setTimeout(() => {
                // Step 3 & 4: Catalog & Comparison
                
                setTimeout(() => {
                    // Step 5: Challenger Agent (Yellow Card)
                    if(chatReasoning) chatReasoning.classList.add('hidden');
                    
                    const responseHtml = `
                        <p>⚙️ <strong>Análisis de Ingeniería Completado por los 5 Agentes:</strong></p>
                        <p><strong>Recomendación Verificada:</strong> ${caseData.recommendation.sku}</p>
                        <p class="msg-sub">${caseData.recommendation.desc}</p>
                        <div style="margin-top: 10px;">
                            <button id="btn-open-dash-chat" class="btn btn-blue btn-sm" style="width:100%; font-weight:600;"><i class="fa-solid fa-sliders"></i> Open Engineering Dashboard</button>
                        </div>
                    `;
                    appendMessage('agent', responseHtml);
                }, 800);
            }, 600);
        }, 500);
    }

    // UPDATE DASHBOARD PANELS DYNAMICALLY
    function updateDashboardCase(c) {
        if(dashUserQuery) dashUserQuery.textContent = `"${c.userText}"`;
        
        // Update Requirements Chips
        if(reqChipsContainer) {
            reqChipsContainer.innerHTML = c.reqs.map(r => `
                <div class="req-chip">
                    <span class="label">${r.label}:</span>
                    <strong class="val">${r.val}</strong>
                </div>
            `).join('');
        }

        // Update Final Recommendation Box
        const recCard = document.getElementById('recommendation-card');
        if(recCard) {
            recCard.innerHTML = `
                <div class="rec-header">
                    <i class="fa-solid fa-circle-check text-green"></i>
                    <h5>Recomendación Final Verificada</h5>
                </div>
                <h4>${c.recommendation.sku}</h4>
                <p class="rec-summary">${c.recommendation.desc}</p>
            `;
        }

        // Update Candidate Products Table
        const tbody = document.querySelector('.specs-table tbody');
        if(tbody && c.candidates) {
            tbody.innerHTML = c.candidates.map(cand => `
                <tr class="${cand.rec ? 'highlight-row' : ''}">
                    <td><strong>${cand.model}</strong> ${cand.rec ? '<span class="badge-tag green">Recomendado</span>' : ''}</td>
                    <td>${cand.spec}</td>
                    <td>${cand.ip}</td>
                    <td>${cand.out}</td>
                    <td>${cand.adv}</td>
                    <td>${cand.match}</td>
                    <td><button class="btn btn-sm ${cand.rec ? 'btn-blue' : 'btn-outline'}">Datasheet</button></td>
                </tr>
            `).join('');
        }

        // Update Challenger Agent Breakdown (Yellow Card Warnings)
        const challengerBox = document.querySelector('.challenger-alert-box');
        if(challengerBox && c.challenger) {
            challengerBox.innerHTML = `
                <h5><i class="fa-solid fa-shield-cat"></i> Análisis de Riesgo Operativo (Challenger Agent):</h5>
                <ul>
                    ${c.challenger.map(w => `<li>${w}</li>`).join('')}
                </ul>
            `;
        }
    }

    function appendMessage(sender, htmlContent) {
        if(!chatMessages) return;
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${sender}-message`;
        const avatarIcon = sender === 'agent' ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-user"></i>';
        
        msgDiv.innerHTML = `
            <div class="msg-avatar">${avatarIcon}</div>
            <div class="msg-bubble">${htmlContent}</div>
        `;
        
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
        );
    }

});


