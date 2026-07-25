/* Consultancy console. Renders the engine's ConsultResult.
   The two scores are shown separately on purpose: fit is how well the product
   matches, evidence is how much of that the catalog could actually confirm. */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    $('status').textContent = h.model_available
      ? `${h.products} productos · modelo activo`
      : `${h.products} productos · sin modelo (orden determinista)`;
  })
  .catch(() => {
    $('status').textContent = 'servidor no disponible';
  });

function collectConstraints() {
  const c = {};
  const distance = $('sensing_distance_mm').value.trim();
  if (distance) c.sensing_distance_mm = Number(distance);
  for (const key of ['communication_protocol', 'environment', 'mounting', 'precision', 'budget']) {
    const v = $(key).value.trim();
    if (v) c[key] = v;
  }
  return Object.keys(c).length ? c : null;
}

function scoresBlock(p) {
  return `
    <div class="scores">
      <div class="score">
        <div class="n"><span>Ajuste técnico</span><span>${pct(p.fit)}</span></div>
        <div class="bar"><i style="width:${pct(p.fit)}"></i></div>
        <small>Coincidencia con lo que se pidió</small>
      </div>
      <div class="score">
        <div class="n"><span>Evidencia en catálogo</span><span>${pct(p.evidence)}</span></div>
        <div class="bar ev"><i style="width:${pct(p.evidence)}"></i></div>
        <small>Cuánto pudo verificarse en el catálogo</small>
      </div>
    </div>`;
}

function skuHeader(p) {
  const link = p.product_url ? `https://${esc(p.product_url)}`.replace('https://https://', 'https://') : null;
  const type = esc(p.type_code || p.order_number);
  return `
    <div class="sku">
      <span class="type">${link ? `<a href="${link}" target="_blank" rel="noopener">${type}</a>` : type}</span>
      <span class="order">Ref. ${esc(p.order_number)}</span>
      <span class="fam">${esc(p.family || '')} · pág. ${esc(p.source_page)}</span>
    </div>
    <p class="pname">${esc(p.product_name || '')}</p>`;
}

function chips(p) {
  const items = [p.solution_class, p.sensing_mode].filter(Boolean);
  return items.length ? `<div class="chips">${items.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div>` : '';
}

function render(r) {
  const out = [];

  if (r.understood_problem.restated) {
    out.push(`
      <div class="card">
        <h2>Problema identificado</h2>
        <p>${esc(r.understood_problem.restated)}</p>
        ${
          r.understood_problem.inferred_needs.length
            ? `<h2 style="margin-top:1rem">Lo que implica</h2>
               <ul class="plain">${r.understood_problem.inferred_needs.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
            : ''
        }
      </div>`);
  }

  for (const n of r.notices) {
    const safety = n.includes('13849') || n.includes('seguridad funcional') || n.includes('Functional-safety');
    out.push(
      `<div class="note ${safety ? 'safety' : 'warn'}"><strong>${safety ? 'Seguridad funcional' : 'Aviso'}</strong>${esc(n)}</div>`,
    );
  }
  for (const n of r.not_applied) {
    out.push(`<div class="note warn"><strong>Restricción no aplicada</strong>${esc(n)}</div>`);
  }

  if (r.recommendation) {
    const p = r.recommendation;
    out.push(`
      <div class="card primary">
        <h2>Recomendación</h2>
        ${skuHeader(p)}
        ${chips(p)}
        ${scoresBlock(p)}
        ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
        ${p.why.length ? `<h2>Por qué</h2><ul class="why">${p.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${
          r.unverified.length
            ? `<h2>Confirmar en la hoja de datos</h2><ul class="plain">${r.unverified
                .map((u) => `<li>${esc(u)}</li>`)
                .join('')}</ul>`
            : ''
        }
      </div>`);
  } else {
    out.push('<div class="card"><h2>Sin resultados</h2><p>No se encontró ningún producto compatible.</p></div>');
  }

  if (r.alternatives.length) {
    out.push(`
      <div class="card">
        <h2>Alternativas</h2>
        ${r.alternatives
          .map(
            (a) => `<div class="alt">
              ${skuHeader(a)}
              ${a.tradeoff_vs_primary ? `<p class="tradeoff">${esc(a.tradeoff_vs_primary)}</p>` : ''}
              ${scoresBlock(a)}
            </div>`,
          )
          .join('')}
      </div>`);
  }

  if (r.complete_the_solution.length) {
    out.push(`
      <div class="card">
        <h2>Completa la instalación</h2>
        <table class="acc">
          ${r.complete_the_solution
            .map((a) => `<tr><td>${esc(a.order_number)}</td><td>${esc(a.type_code || '')}</td><td>${esc(a.description || '')}</td></tr>`)
            .join('')}
        </table>
      </div>`);
  }

  const d = r.diagnostics;
  out.push(
    `<p class="diag">${d.candidates_considered} candidatos · ${d.excluded_count} descartados por una especificación declarada · ` +
      `análisis ${d.llm_parse ? 'con modelo' : 'determinista'}${d.llm_adjudication ? ' + adjudicación' : ''}` +
      `${d.dropped_order_numbers.length ? ` · ${d.dropped_order_numbers.length} referencia(s) inventada(s) descartada(s)` : ''}</p>`,
  );

  const el = $('results');
  el.innerHTML = out.join('');
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submit');
  btn.disabled = true;
  btn.textContent = 'Analizando…';
  try {
    const res = await fetch('/api/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        problem_description: $('problem').value,
        industry: $('industry').value.trim() || null,
        application: $('application').value.trim() || null,
        constraints: collectConstraints(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error del servidor');
    render(data);
  } catch (err) {
    const el = $('results');
    el.innerHTML = `<div class="note warn"><strong>Error</strong>${esc(err.message)}</div>`;
    el.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analizar y recomendar';
  }
});
