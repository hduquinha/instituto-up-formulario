(function(){
  const form = document.getElementById('leadForm');
  const steps = Array.from(document.querySelectorAll('.step'));
  const progressBar = document.getElementById('progressBar');
  const alertBox = document.getElementById('alert');
  const saving = document.getElementById('saving');

  // Configuration from config.js
  const { SERVER_URL, GAS_WEB_APP_URL, SHEET_ID } = window.FORM_CONFIG || {};

  const state = {
    current: 0,
    clientId: getOrCreateClientId(),
    data: {}
  };

  // Restore partial data from localStorage if available
  restoreFromStorage();
  updateUI();

  // Event delegation for navigation
  form.addEventListener('click', (e)=>{
    const nextBtn = e.target.closest('[data-next]');
    const backBtn = e.target.closest('[data-back]');
    if(nextBtn){
      handleNext();
    }
    if(backBtn){
      handleBack();
    }
  });

  // Save on submit
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const valid = validateStep(state.current);
    if(!valid) return;
    await saveStep(state.current, true);
    showAlert('Inscrição enviada com sucesso! Em breve você receberá os detalhes da aula no seu email/WhatsApp.', 'success');
    form.reset();
    localStorage.removeItem('leadForm:data');
    localStorage.removeItem('leadForm:clientId');
    state.current = 0;
    state.clientId = getOrCreateClientId(true);
    state.data = {};
    updateUI();
  });

  // Input change tracking for autosave per step (debounced)
  form.addEventListener('input', debounce(()=>{
    collectStepData(state.current);
    persistToStorage();
  }, 300));

  function handleNext(){
    if(!validateStep(state.current)) return;
    saveStep(state.current);
    if(state.current < steps.length - 1){
      state.current++;
      updateUI();
    }
  }

  function handleBack(){
    if(state.current > 0){
      state.current--;
      updateUI();
    }
  }

  function updateUI(){
    steps.forEach((s, idx)=>{
      s.hidden = idx !== state.current;
    });
    const pct = ((state.current) / (steps.length - 1)) * 100;
    progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    // Fill fields with current state
    applyDataToFields();
  }

  function collectStepData(stepIdx){
    const section = steps[stepIdx];
    const inputs = section.querySelectorAll('input, textarea, select');
    const payload = {};
    inputs.forEach(el => {
      if(el.type === 'radio'){
        if(el.checked) payload[el.name] = el.value;
      } else if(el.type === 'checkbox'){
        if(!payload[el.name]) payload[el.name] = [];
        if(el.checked) payload[el.name].push(el.value);
      } else {
        payload[el.name] = el.value;
      }
    });
    state.data = { ...state.data, ...payload };
    return payload;
  }

  async function saveStep(stepIdx, final=false){
    const endpoint = SERVER_URL || GAS_WEB_APP_URL;
    if(!endpoint){
      showAlert('Configuração pendente: defina SERVER_URL ou GAS_WEB_APP_URL em config.js', 'error');
      return;
    }
    const stepPayload = collectStepData(stepIdx);
    persistToStorage();
    const meta = {
      step: stepIdx + 1,
      final,
      ts: new Date().toISOString(),
      page: location.href,
      sheetId: SHEET_ID || undefined,
      clientId: state.clientId
    };
    const body = { ...state.data, ...stepPayload, _meta: meta };
    try{
      saving.hidden = false;
      const res = await fetch(endpoint, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(()=>({ ok:false }));
      saving.hidden = true;
      if(!res.ok || json.ok === false){
        throw new Error(json?.error || 'Falha ao salvar');
      }
      showAlert(final ? 'Formulário concluído!' : 'Progresso salvo.', 'success', 1800);
    }catch(err){
      saving.hidden = true;
      console.error(err);
      showAlert('Não foi possível salvar agora. Sua resposta está segura no dispositivo e tentaremos novamente.', 'error', 4000);
    }
  }

  function validateStep(stepIdx){
    const section = steps[stepIdx];
    let valid = true;
    // Clear previous errors
    section.querySelectorAll('.error').forEach(el=> el.textContent = '');
    const requiredFields = section.querySelectorAll('[required]');
    requiredFields.forEach(el => {
      if(el.type === 'radio'){
        const name = el.name;
        const checked = section.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
        if(!checked){
          const err = section.querySelector(`.error[data-for="${name}"]`);
          if(err) err.textContent = 'Selecione uma opção.';
          valid = false;
        }
      } else if(!el.value || (el.type==='email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value))){
        const name = el.name || el.id;
        const err = section.querySelector(`.error[data-for="${name}"]`);
        if(err){
          err.textContent = el.type==='email' ? 'Informe um email válido.' : 'Campo obrigatório.';
        }
        valid = false;
      }
    });
    return valid;
  }

  function showAlert(message, type='success', timeout=2500){
    alertBox.textContent = message;
    alertBox.className = `alert ${type==='error' ? 'error' : ''}`;
    alertBox.hidden = false;
    if(timeout){
      clearTimeout(showAlert._t);
      showAlert._t = setTimeout(()=>{ alertBox.hidden = true; }, timeout);
    }
  }

  function persistToStorage(){
    localStorage.setItem('leadForm:data', JSON.stringify({ data: state.data, step: state.current }));
    localStorage.setItem('leadForm:clientId', state.clientId);
  }

  function restoreFromStorage(){
    try{
      const raw = localStorage.getItem('leadForm:data');
      if(!raw) return;
      const parsed = JSON.parse(raw);
      if(parsed?.data) state.data = parsed.data;
      if(Number.isInteger(parsed?.step)) state.current = Math.min(Math.max(0, parsed.step), steps.length-1);
    }catch{}
  }

  function applyDataToFields(){
    const section = steps[state.current];
    const inputs = section.querySelectorAll('input, textarea, select');
    inputs.forEach(el => {
      const val = state.data[el.name];
      if(val === undefined) return;
      if(el.type === 'radio'){
        el.checked = (val === el.value);
      } else if(el.type === 'checkbox'){
        if(Array.isArray(val)) el.checked = val.includes(el.value);
      } else {
        el.value = val;
      }
    });
  }

  function getOrCreateClientId(forceNew=false){
    if(!forceNew){
      const existing = localStorage.getItem('leadForm:clientId');
      if(existing) return existing;
    }
    const id = cryptoRandomId();
    localStorage.setItem('leadForm:clientId', id);
    return id;
  }

  function cryptoRandomId(){
    try{
      const arr = new Uint8Array(16);
      (self.crypto || window.crypto).getRandomValues(arr);
      return Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
    }catch{
      return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  function debounce(fn, wait){
    let t; return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this,args), wait); };
  }
})();
