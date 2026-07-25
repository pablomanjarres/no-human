/* ENGINEERING COPILOT
   El popup resuelve consultas sencillas. Todo lo que huela a ingeniería
   (equivalencias, especificaciones, comparativas) se entrega a la consola
   de análisis avanzado, que es donde vive el análisis completo. */

document.addEventListener('DOMContentLoaded', () => {
    const CONSOLE_URL = 'https://sick-cross.vercel.app/console';

    const panel = document.getElementById('cp-panel');
    const launcher = document.getElementById('cp-launcher');
    const closeBtn = document.getElementById('cp-close');
    const thread = document.getElementById('cp-thread');
    const form = document.getElementById('cp-form');
    const input = document.getElementById('cp-input');
    const sendBtn = document.getElementById('cp-send');
    const examples = document.getElementById('cp-examples');

    if (!panel || !launcher) return;

    const GREETING =
        'Soy el copiloto de SICK. Respondo consultas rápidas sobre el catálogo, la empresa y el soporte. Las equivalencias y comparativas técnicas las paso al análisis avanzado.';

    /* Reglas en orden: la primera que coincide decide la respuesta.
       Si ninguna coincide, la consulta se escala. Nunca inventamos datos. */
    const RULES = [
        {
            kind: 'simple',
            test: /^(hola|buenas|hey|hi|hello|buenos dias|buenas tardes|buenas noches|que tal)\b/,
            reply: 'Hola. Dime qué necesitas detectar o medir. Si la consulta pide comparar modelos o buscar equivalencias, la abro en el análisis avanzado.',
        },
        {
            kind: 'simple',
            test: /^(gracias|muchas gracias|thanks|perfecto|genial|de acuerdo|vale|ok)\b/,
            reply: 'A tu disposición. Si aparece una comparativa técnica, escríbela y la paso al análisis avanzado.',
        },
        {
            kind: 'simple',
            test: /(que (puedes|sabes|podes) (hacer|responder))|(que (te )?puedo preguntar)|(en que (me )?ayudas)|(para que sirves)|^ayuda\b/,
            reply: 'Respondo lo sencillo: qué es SICK, qué familias de producto existen, cómo contactar con soporte y dónde estamos. La selección por especificación, las equivalencias entre marcas y las comparativas de rango o salida pasan al análisis avanzado.',
        },
        {
            /* Comercial: ni el popup ni la consola de ingeniería lo cubren. */
            kind: 'alert',
            test: /(precio|coste|costo|cuanto (cuesta|vale)|cotiza|presupuesto|plazo|entrega|stock|disponibilidad|descuento|factura|pedido|comprar|envio)/,
            reply: 'Precios, plazos y pedidos no se consultan aquí. Escribe al equipo de ventas desde «Póngase en contacto con nosotros», en el pie de página.',
        },
        {
            /* Marcas de la competencia y vocabulario de equivalencia. */
            kind: 'advanced',
            test: /(equivalen|reemplaz|sustitut|cross.?ref|crossref|compatib|homolog|banner|keyence|omron|pepperl|ifm |balluff|turck|datalogic|leuze|autonics|wenglor)/,
        },
        {
            /* Vocabulario de especificación. */
            kind: 'advanced',
            test: /(alcance|rango|distancia de conmutacion|ip6[5-9]|histeresis|pnp|npn|io.?link|\bsil\b|\bpl [a-e]\b|categoria [1-4]|tiempo de respuesta|frecuencia de conmutacion|longitud de onda|supresion de fondo|analogic|salida|comparar|comparativa|selecciona|dimensiona|configura|ficha tecnica|datasheet|analisis)/,
        },
        {
            /* Referencia de producto: letras + dígitos pegados (WTB4-3, LMS511, Q45). */
            kind: 'advanced',
            test: /\b[a-z]{1,4}\d{1,4}[a-z0-9-]*\b/,
        },
        {
            kind: 'simple',
            test: /(que es sick)|(quien es sick)|(sobre sick)|(acerca de sick)|(a que se dedica)/,
            reply: 'SICK fabrica sensores industriales: fotoeléctricos, láser, visión, identificación y seguridad de máquinas. Su lema es Sensor Intelligence.',
        },
        {
            kind: 'simple',
            test: /(gama|catalogo|familias|que productos|tipos de sensor|linea de producto|portafolio)/,
            reply: 'El catálogo cubre fotoeléctricos, barreras y cortinas de seguridad, escáneres láser, visión, codificadores e identificación. Dime qué necesitas resolver y, si hay que comparar modelos, lo paso al análisis avanzado.',
        },
        {
            kind: 'simple',
            test: /(contact|soporte|support|telefono|asesor|correo|email|mail|servicio tecnico)/,
            reply: 'Tienes el contacto y el soporte en el pie de página, en «Póngase en contacto con nosotros». Para gestionarlo tú mismo, el portal My SICK.',
        },
        {
            kind: 'simple',
            test: /(donde est|ubicacion|oficinas|sede|sucursal|filial|pais)/,
            reply: 'SICK es alemana, con sede en Waldkirch, y tiene filiales en más de 40 países. El selector de país está al final de la página.',
        },
        {
            kind: 'simple',
            test: /(horario|a que hora|abren|cierran)/,
            reply: 'El horario depende de la filial. Lo tienes en la página de contacto, junto al teléfono de tu país.',
        },
    ];

    const normalize = (text) =>
        text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();

    const classify = (query) => {
        const text = normalize(query);
        /* Una consulta larga casi nunca es sencilla. */
        if (text.length > 160) return { kind: 'advanced' };
        const rule = RULES.find((r) => r.test.test(text));
        return rule || { kind: 'advanced' };
    };

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    };

    const scrollToEnd = () => {
        thread.scrollTop = thread.scrollHeight;
    };

    const addMessage = (role, text) => {
        const node = el('div', `cp-msg cp-msg-${role}`, text);
        thread.appendChild(node);
        scrollToEnd();
    };

    const addAlert = (text) => {
        const card = el('div', 'cp-alert');
        const icon = el('i', 'fa-solid fa-triangle-exclamation');
        icon.setAttribute('aria-hidden', 'true');
        card.append(icon, el('p', null, text));
        thread.appendChild(card);
        scrollToEnd();
    };

    const addEscalation = (query) => {
        const card = el('div', 'cp-escalate');
        card.append(
            el('p', 'cp-escalate-title', 'Este caso requiere análisis de ingeniería.'),
            el('p', 'cp-escalate-echo', query),
        );

        const cta = el('a', 'cp-escalate-cta', 'Abrir análisis avanzado →');
        cta.href = `${CONSOLE_URL}?q=${encodeURIComponent(query)}`;
        cta.target = '_blank';
        cta.rel = 'noopener noreferrer';
        card.appendChild(cta);

        card.appendChild(
            el(
                'p',
                'cp-escalate-note',
                'El análisis completo se ejecuta en el panel avanzado.',
            ),
        );

        thread.appendChild(card);
        scrollToEnd();
    };

    const showTyping = () => {
        const node = el('div', 'cp-msg cp-msg-bot cp-typing');
        node.setAttribute('aria-hidden', 'true');
        node.append(el('span'), el('span'), el('span'));
        thread.appendChild(node);
        scrollToEnd();
        return node;
    };

    const respondTo = (query) => {
        const typing = showTyping();
        const delay = Math.min(420 + query.length * 10, 900);

        setTimeout(() => {
            typing.remove();
            const result = classify(query);

            if (result.kind === 'simple') {
                addMessage('bot', result.reply);
            } else if (result.kind === 'alert') {
                addAlert(result.reply);
            } else {
                addEscalation(query);
            }
        }, delay);
    };

    const submitQuery = (raw) => {
        const query = raw.trim();
        if (!query) return;

        if (examples) examples.hidden = true;
        addMessage('user', query);
        input.value = '';
        autoGrow();
        syncSendState();
        respondTo(query);
    };

    /* ---------- Composer ---------- */
    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 92)}px`;
    }

    function syncSendState() {
        sendBtn.disabled = !input.value.trim();
    }

    input.addEventListener('input', () => {
        autoGrow();
        syncSendState();
    });

    /* Enter envía; Shift+Enter salta de línea. */
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitQuery(input.value);
        }
    });

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        submitQuery(input.value);
    });

    if (examples) {
        examples.querySelectorAll('.cp-chip').forEach((chip) => {
            chip.addEventListener('click', () => submitQuery(chip.dataset.query));
        });
    }

    /* ---------- Abrir / cerrar ---------- */
    let started = false;
    let hideTimer = null;

    const openPanel = () => {
        /* Reabrir antes de que termine la animación de cierre no debe dejar
           pendiente el timeout que oculta el panel. */
        clearTimeout(hideTimer);
        panel.hidden = false;
        requestAnimationFrame(() => panel.classList.add('is-open'));
        launcher.setAttribute('aria-expanded', 'true');

        if (!started) {
            started = true;
            addMessage('bot', GREETING);
        }
        input.focus();
    };

    const closePanel = ({ restoreFocus = true } = {}) => {
        panel.classList.remove('is-open');
        launcher.setAttribute('aria-expanded', 'false');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            panel.hidden = true;
        }, 180);
        if (restoreFocus) launcher.focus();
    };

    /* El atributo `hidden` va 180 ms por detrás (dura la animación de cierre),
       así que el estado real lo marca la clase. */
    const isOpen = () => panel.classList.contains('is-open');

    launcher.addEventListener('click', () => {
        if (isOpen()) closePanel();
        else openPanel();
    });

    closeBtn.addEventListener('click', () => closePanel());

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) closePanel();
    });

    syncSendState();
});
