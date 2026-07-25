// Catálogo de productos: lee data/catalog.json (generado por scripts/build-catalog-data.mjs)
// y pinta una referencia por tarjeta con su foto extraída del catálogo original.

(() => {
    const PAGE_SIZE = 48;
    const IMAGE_DIR = 'assets/products';

    const el = {
        grid: document.getElementById('grid'),
        count: document.getElementById('result-count'),
        coverage: document.getElementById('coverage-note'),
        empty: document.getElementById('empty-state'),
        loadMore: document.getElementById('load-more'),
        q: document.getElementById('q'),
        category: document.getElementById('category'),
        kind: document.getElementById('kind'),
        onlyImages: document.getElementById('only-images'),
        reset: document.getElementById('reset'),
        panel: document.getElementById('detail-panel'),
        panelBody: document.getElementById('panel-body'),
        panelClose: document.getElementById('panel-close'),
        backdrop: document.getElementById('panel-backdrop'),
    };

    let all = [];
    let byOrder = new Map();
    let filtered = [];
    let shown = 0;
    let lastFocused = null;

    const nf = new Intl.NumberFormat('es-ES');

    // ---------------------------------------------------------------- carga

    fetch('data/catalog.json')
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((data) => {
            all = data.products;
            byOrder = new Map(all.map((p) => [p.order_number, p]));
            for (const p of all) {
                p._haystack = [p.order_number, p.type_code, p.family, p.subfamily, p.name, p.category]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
            }

            for (const c of data.categories) {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                el.category.append(opt);
            }

            const s = data.summary;
            el.coverage.textContent =
                `${nf.format(s.with_image)} de ${nf.format(s.total)} referencias tienen foto en el catálogo ` +
                `(${s.coverage_pct.toString().replace('.', ',')} %). ` +
                `De ellas, ${nf.format(s.family_photo_count)} usan la foto de la familia en lugar de la ` +
                `variante exacta. Las ${nf.format(s.total - s.with_image)} restantes no traen foto en el ` +
                `catálogo original y se muestran sin imagen.`;

            applyFilters();
            openFromHash();
        })
        .catch((err) => {
            el.count.textContent =
                'No se pudo cargar data/catalog.json. Genérelo con: node scripts/build-catalog-data.mjs';
            console.error('catalog load failed', err);
        });

    // ---------------------------------------------------------------- filtros

    function applyFilters() {
        const q = el.q.value.trim().toLowerCase();
        const cat = el.category.value;
        const kind = el.kind.value;
        const onlyImg = el.onlyImages.checked;

        filtered = all.filter((p) => {
            if (cat && p.category !== cat) return false;
            if (kind && p.row_type !== kind) return false;
            if (onlyImg && !p.image) return false;
            if (q && !p._haystack.includes(q)) return false;
            return true;
        });

        el.grid.replaceChildren();
        shown = 0;
        renderNext();

        const withImg = filtered.filter((p) => p.image).length;
        el.count.textContent = filtered.length
            ? `${nf.format(filtered.length)} referencias · ${nf.format(withImg)} con imagen`
            : '';
        el.empty.hidden = filtered.length > 0;
    }

    function renderNext() {
        const slice = filtered.slice(shown, shown + PAGE_SIZE);
        const frag = document.createDocumentFragment();
        for (const p of slice) frag.append(buildCard(p));
        el.grid.append(frag);
        shown += slice.length;
        el.loadMore.hidden = shown >= filtered.length;
    }

    // ---------------------------------------------------------------- tarjeta

    function buildMedia(p, big) {
        const box = document.createElement('div');
        box.className = big ? 'panel-media' : 'card-media';

        if (!p.image) {
            box.classList.add('no-image');
            const icon = document.createElement('i');
            icon.className = 'fa-regular fa-image';
            icon.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = 'Sin imagen en el catálogo';
            box.append(icon, label);
            return box;
        }

        const img = document.createElement('img');
        img.src = `${IMAGE_DIR}/${p.image}`;
        img.alt = `${p.type_code || p.order_number}${p.name ? ` — ${p.name}` : ''}`;
        img.loading = 'lazy';
        img.decoding = 'async';
        box.append(img);

        if (!big && p.image_is_family_photo) {
            const flag = document.createElement('span');
            flag.className = 'family-flag';
            flag.textContent = 'Foto de familia';
            flag.title = 'La foto corresponde a la familia, no a esta variante exacta';
            box.append(flag);
        }
        return box;
    }

    function buildCard(p) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'product-card';
        card.dataset.order = p.order_number;
        card.setAttribute(
            'aria-label',
            `Ver detalles de ${p.type_code || p.order_number}, referencia ${p.order_number}`
        );

        const body = document.createElement('div');
        body.className = 'card-body';

        if (p.family) {
            const fam = document.createElement('span');
            fam.className = 'card-family';
            fam.textContent = p.subfamily && p.subfamily !== p.family ? `${p.family} · ${p.subfamily}` : p.family;
            body.append(fam);
        }

        const type = document.createElement('span');
        type.className = 'card-type';
        type.textContent = p.type_code || p.order_number;
        body.append(type);

        if (p.name || p.headline) {
            const name = document.createElement('span');
            name.className = 'card-name';
            name.textContent = p.name || p.headline;
            body.append(name);
        }

        const meta = document.createElement('div');
        meta.className = 'card-meta';
        const order = document.createElement('span');
        order.className = 'card-order';
        order.textContent = p.order_number;
        const kind = document.createElement('span');
        kind.className = 'card-kind';
        kind.textContent = p.row_type === 'accessory' ? 'Accesorio' : 'Producto';
        meta.append(order, kind);
        body.append(meta);

        card.append(buildMedia(p, false), body);
        card.addEventListener('click', () => openPanel(p, card));
        return card;
    }

    // ---------------------------------------------------------------- panel

    const IMAGE_NOTES = {
        row_aligned: 'Foto tomada de la fila de esta referencia en la tabla del catálogo (página %P).',
        page_hero: 'Foto de la página %P del catálogo, donde aparece esta referencia. Representa la familia de producto.',
        family_hero: 'Foto de la familia, tomada de su página de apertura (%P). La página de esta variante no trae foto propia.',
        family_hero_loose:
            'Foto de la familia, tomada de su página de apertura (%P). Puede no reflejar el acabado exacto de esta variante.',
    };

    function openPanel(p, trigger) {
        lastFocused = trigger || document.activeElement;
        el.panelBody.replaceChildren();

        el.panelBody.append(buildMedia(p, true));

        if (p.family) {
            const fam = document.createElement('div');
            fam.className = 'panel-family';
            fam.textContent = p.subfamily && p.subfamily !== p.family ? `${p.family} · ${p.subfamily}` : p.family;
            el.panelBody.append(fam);
        }

        const h2 = document.createElement('h2');
        h2.id = 'detail-title';
        h2.textContent = p.type_code || p.order_number;
        el.panelBody.append(h2);

        const order = document.createElement('p');
        order.className = 'panel-order';
        order.textContent = `Referencia ${p.order_number} · ${p.category} · página ${p.source_page}`;
        el.panelBody.append(order);

        if (p.name) {
            const name = document.createElement('p');
            name.className = 'panel-name';
            name.textContent = p.name;
            el.panelBody.append(name);
        }

        const note = document.createElement('p');
        note.className = 'image-note';
        note.textContent = p.image
            ? (IMAGE_NOTES[p.image_match] || '').replace('%P', p.image_page)
            : 'El catálogo original no incluye foto para esta referencia, por lo que no se muestra ninguna.';
        el.panelBody.append(note);

        if (p.specs.length) {
            const h3 = document.createElement('h3');
            h3.textContent = 'Datos técnicos';
            el.panelBody.append(h3);

            const table = document.createElement('table');
            table.className = 'spec-table';
            const tbody = document.createElement('tbody');
            for (const s of p.specs) {
                const tr = document.createElement('tr');
                const th = document.createElement('th');
                th.scope = 'row';
                th.textContent = s.label;
                if (s.low) th.classList.add('spec-low');
                const td = document.createElement('td');
                td.textContent = s.value;
                tr.append(th, td);
                tbody.append(tr);
            }
            table.append(tbody);
            el.panelBody.append(table);

            if (p.specs.some((s) => s.low)) {
                const legend = document.createElement('p');
                legend.className = 'spec-legend';
                legend.textContent =
                    '* Dato leído de texto descriptivo y no de una celda etiquetada del catálogo: conviene verificarlo.';
                el.panelBody.append(legend);
            }
        }

        if (p.url) {
            const link = document.createElement('a');
            link.className = 'panel-link';
            link.href = `https://${p.url.replace(/^https?:\/\//, '')}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = `${p.url} →`;
            el.panelBody.append(link);
        }

        el.panel.hidden = false;
        el.backdrop.hidden = false;
        document.body.style.overflow = 'hidden';
        el.panelClose.focus();
        history.replaceState(null, '', `#ref=${p.order_number}`);
    }

    function closePanel() {
        el.panel.hidden = true;
        el.backdrop.hidden = true;
        document.body.style.overflow = '';
        history.replaceState(null, '', location.pathname + location.search);
        if (lastFocused) lastFocused.focus();
    }

    function openFromHash() {
        const m = /#ref=(\d{7})/.exec(location.hash);
        if (!m) return;
        const p = byOrder.get(m[1]);
        if (p) openPanel(p, null);
    }

    // ---------------------------------------------------------------- eventos

    let debounce;
    el.q.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(applyFilters, 140);
    });
    el.category.addEventListener('change', applyFilters);
    el.kind.addEventListener('change', applyFilters);
    el.onlyImages.addEventListener('change', applyFilters);
    el.loadMore.addEventListener('click', renderNext);

    el.reset.addEventListener('click', () => {
        el.q.value = '';
        el.category.value = '';
        el.kind.value = '';
        el.onlyImages.checked = false;
        applyFilters();
        el.q.focus();
    });

    el.panelClose.addEventListener('click', closePanel);
    el.backdrop.addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !el.panel.hidden) closePanel();
    });
})();
