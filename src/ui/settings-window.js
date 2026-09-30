document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperResponseTargetSelect = document.getElementById('whisperResponseTarget');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const callAudioInputSelect = document.getElementById('callAudioInput');
    const micAudioInputSelect = document.getElementById('micAudioInput');
    const callAudioLevel = document.getElementById('callAudioLevel');
    const micAudioLevel = document.getElementById('micAudioLevel');
    const callAudioStatus = document.getElementById('callAudioStatus');
    const micAudioStatus = document.getElementById('micAudioStatus');
    const geminiKeyInput = document.getElementById('geminiKey');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    let settingsVisible = false;
    let callAudioInputId = 'default';
    let micAudioInputId = 'off';
    let audioSettingsLoaded = false;
    let availableAudioInputIds = new Set();
    let needsLabelRefresh = false;
    let labelRefreshAttempted = false;
    let settingsRequestSeq = 0;
    const callMonitor = new window.AudioInputMonitor(
        (level) => updateAudioLevel(callAudioLevel, callAudioStatus, level),
        (error) => { callAudioStatus.textContent = audioErrorLabel(error); }
    );
    const micMonitor = new window.AudioInputMonitor(
        (level) => updateAudioLevel(micAudioLevel, micAudioStatus, level),
        (error) => { micAudioStatus.textContent = audioErrorLabel(error); }
    );

    function audioErrorLabel(error) {
        if (error.name === 'NotAllowedError') return 'Permissão negada';
        if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'Fonte indisponível';
        return error.message || 'Erro na captura';
    }

    function updateAudioLevel(meter, status, level) {
        const value = Math.min(100, Math.round(level * 500));
        meter.value = value;
        const label = value > 4 ? 'Sinal detectado' : 'Sem sinal';
        if (status.textContent !== label) status.textContent = label;
    }

    function stopAudioMonitors() {
        callMonitor.stop();
        micMonitor.stop();
    }

    function populateAudioSelect(select, devices, selectedId, defaultLabel, defaultId) {
        select.replaceChildren(new Option(defaultLabel, defaultId));
        devices.forEach((device, index) => {
            if (device.deviceId && device.deviceId !== 'default') {
                select.add(new Option(device.label || `Entrada ${index + 1}`, device.deviceId));
            }
        });
        if (selectedId !== defaultId && !availableAudioInputIds.has(selectedId)) {
            select.add(new Option('Dispositivo indisponível', selectedId));
        }
        select.value = selectedId;
    }

    async function refreshAudioDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) {
            callAudioStatus.textContent = 'Captura indisponível';
            micAudioStatus.textContent = 'Captura indisponível';
            return;
        }
        try {
            const devices = (await navigator.mediaDevices.enumerateDevices())
                .filter(device => device.kind === 'audioinput');
            needsLabelRefresh = !labelRefreshAttempted && devices.some(device => !device.label);
            availableAudioInputIds = new Set(devices.map(device => device.deviceId));
            populateAudioSelect(callAudioInputSelect, devices, callAudioInputId,
                'Entrada padrão do sistema', 'default');
            populateAudioSelect(micAudioInputSelect, devices, micAudioInputId,
                'Não monitorar', 'off');
            updateAudioMonitors();
        } catch (error) {
            callAudioStatus.textContent = audioErrorLabel(error);
            micAudioStatus.textContent = callAudioStatus.textContent;
        }
    }

    function updateAudioMonitors() {
        if (!settingsVisible || document.hidden || speechProviderSelect.value !== 'whisper') {
            stopAudioMonitors();
            return;
        }
        if (callAudioInputId !== 'default' && !availableAudioInputIds.has(callAudioInputId)) {
            callMonitor.stop();
            callAudioStatus.textContent = 'Fonte indisponível';
        } else {
            callAudioStatus.textContent = 'Conectando…';
            const starting = callMonitor.start(callAudioInputId);
            if (needsLabelRefresh) {
                needsLabelRefresh = false;
                labelRefreshAttempted = true;
                starting.then(() => {
                    if (settingsVisible && callMonitor.stream) refreshAudioDevices();
                });
            }
        }
        if (micAudioInputId === 'off') {
            micMonitor.stop();
            micAudioStatus.textContent = 'Desligado';
        } else if (!availableAudioInputIds.has(micAudioInputId)) {
            micMonitor.stop();
            micAudioStatus.textContent = 'Fonte indisponível';
        } else {
            micAudioStatus.textContent = 'Conectando…';
            micMonitor.start(micAudioInputId);
        }
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            const requestSeq = ++settingsRequestSeq;
            window.electronAPI.getSettings().then(settings => {
                if (requestSeq !== settingsRequestSeq) return;
                loadSettingsIntoUI(settings);
            }).catch(error => {
                if (requestSeq !== settingsRequestSeq) return;
                console.error('Failed to get settings:', error);
                refreshAudioDevices();
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            settingsVisible = false;
            stopAudioMonitors();
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            settingsVisible = false;
            stopAudioMonitors();
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperResponseTargetSelect) whisperResponseTargetSelect.value = settings.whisperResponseTarget || 'both';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        callAudioInputId = settings.callAudioInputId || 'default';
        micAudioInputId = settings.micAudioInputId || 'off';
        audioSettingsLoaded = true;
        refreshAudioDevices();
        if (geminiKeyInput) geminiKeyInput.value = settings.geminiKey || '';
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            settingsVisible = true;
            labelRefreshAttempted = false;
            requestCurrentSettings();
        });
        window.electronAPI.receive('settings-window-hidden', () => {
            settingsVisible = false;
            stopAudioMonitors();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    window.electronAPI.onSkillChanged((event, data) => {
        if (data && data.skill && activeSkillSelect) {
            activeSkillSelect.value = data.skill;
        }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperResponseTargetSelect) settings.whisperResponseTarget = whisperResponseTargetSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (audioSettingsLoaded) {
            settings.callAudioInputId = callAudioInputId;
            settings.micAudioInputId = micAudioInputId;
        }
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        
        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperResponseTargetSelect, whisperSegmentMsInput,
            callAudioInputSelect, micAudioInputSelect].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
        updateAudioMonitors();
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperResponseTargetSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    callAudioInputSelect.addEventListener('change', () => {
        callAudioInputId = callAudioInputSelect.value;
        updateAudioMonitors();
        saveSettings();
    });
    micAudioInputSelect.addEventListener('change', () => {
        micAudioInputId = micAudioInputSelect.value;
        updateAudioMonitors();
        saveSettings();
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioDevices);
    window.addEventListener('pointerdown', () => {
        const callResume = callMonitor.audioContext?.resume?.();
        const micResume = micMonitor.audioContext?.resume?.();
        callResume?.catch(() => {});
        micResume?.catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopAudioMonitors();
        else if (settingsVisible) refreshAudioDevices();
    });

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 
