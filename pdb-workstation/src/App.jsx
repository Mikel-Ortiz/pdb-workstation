/**
 * PDB Drug Discovery Workstation — v2
 * ─────────────────────────────────────────────────────────
 * Pega en src/App.jsx en StackBlitz (stackblitz.com/fork/react)
 * Primera línea debe ser:
 *   import React, { useState, useCallback, useEffect, useRef } from "react";
 *
 * Nuevas funcionalidades v2:
 *   1. Visualizador 3D NGL en panel lateral (pestaña Búsqueda)
 *   2. Búsqueda por UniProt ID
 *   3. Descarga ZIP con CSV de druggability incluido
 *   4. Análisis de interacciones co-cristal (tabla + diagrama SVG)
 */
import React, { useState, useCallback, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════════════════════
   CONSTANTES
═══════════════════════════════════════════════════════════ */
const RCSB = {
  search: "https://search.rcsb.org/rcsbsearch/v2/query",
  gql:    "https://data.rcsb.org/graphql",
  file:   id => `https://files.rcsb.org/download/${id.toUpperCase()}.pdb`,
  page:   id => `https://www.rcsb.org/structure/${id}`,
};
const NGL_URL   = "https://cdn.jsdelivr.net/npm/ngl@2.0.0-dev.37/dist/ngl.js";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

const EXP_METHODS = [
  "X-RAY DIFFRACTION","ELECTRON MICROSCOPY","SOLUTION NMR",
  "NEUTRON DIFFRACTION","ELECTRON CRYSTALLOGRAPHY","SOLID-STATE NMR",
];
const SOLVENTS = new Set([
  "HOH","WAT","DOD","SO4","PO4","EDO","MPD","GOL","PEG","DMS","ACT","CIT",
  "FMT","MES","EPE","BME","DTT","TLA","ACE","EOH","IMD","TRS","DIO","IPA",
  "THP","BOG","SDS","CAC","FLC","NAG","MAN","GLC","SUC","OXY","AZI","MLI",
]);
const TOOLS = [
  { id:"dogsite", name:"DoGSiteScorer", badge:"DOG", col:"#38bdf8",
    url: id=>`https://proteins.plus/${id.toLowerCase()}`,
    hint:"El enlace abre tu estructura en ProteinsPlus. Selecciona DoGSiteScorer. D-score ≥ 0.5 = druggable.",
    fields:[{k:"score",l:"D-Score",s:true},{k:"vol",l:"Vol Å³"},{k:"depth",l:"Prof Å"},{k:"hydro",l:"Hidrofob"}] },
  { id:"fpocket", name:"FPocketWeb", badge:"FPW", col:"#34d399",
    url: ()=>"https://durrantlab.com/fpocketweb/",
    hint:"Corre en tu navegador (sin subir datos). Sube el PDB limpio de la pestaña Descarga. Drug_score ≥ 0.5 = druggable.",
    fields:[{k:"score",l:"Drug Score",s:true},{k:"vol",l:"Vol Å³"},{k:"polarity",l:"Polaridad"},{k:"nres",l:"# Res"}] },
  { id:"castp", name:"CASTp 3.0", badge:"CSP", col:"#fbbf24",
    url: id=>`https://sts.bioe.uic.edu/castp/index.html?${id.toLowerCase()}`,
    hint:"Topografía superficial. MS Vol > 500 Å³ = bolsillo amplio.",
    fields:[{k:"saArea",l:"SA Área"},{k:"saVol",l:"SA Vol"},{k:"msArea",l:"MS Área"},{k:"msVol",l:"MS Vol"}] },
];

/* ═══════════════════════════════════════════════════════════
   UTILIDADES
═══════════════════════════════════════════════════════════ */
const loadScript = url => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${url}"]`)) { setTimeout(res, 100); return; }
  const s = document.createElement("script");
  s.src = url; s.onload = res; s.onerror = rej;
  document.head.appendChild(s);
});

/* ═══════════════════════════════════════════════════════════
   RCSB API
═══════════════════════════════════════════════════════════ */
const buildTextQuery = (text, f) => {
  const nodes = [];
  if (text.trim())      nodes.push({type:"terminal",service:"full_text",parameters:{value:text.trim()}});
  if (f.maxRes)         nodes.push({type:"terminal",service:"text",parameters:{attribute:"rcsb_entry_info.resolution_combined",operator:"less_or_equal",value:parseFloat(f.maxRes)}});
  if (f.method)         nodes.push({type:"terminal",service:"text",parameters:{attribute:"exptl.method",operator:"exact_match",value:f.method}});
  if (f.ligand.trim())  nodes.push({type:"terminal",service:"text",parameters:{attribute:"rcsb_nonpolymer_entity_container_identifiers.comp_id",operator:"exact_match",value:f.ligand.trim().toUpperCase()}});
  if (f.species.trim()) nodes.push({type:"terminal",service:"text",parameters:{attribute:"rcsb_entity_source_organism.ncbi_scientific_name",operator:"contains_phrase",value:f.species.trim()}});
  const q = nodes.length===1 ? nodes[0] : nodes.length>1 ? {type:"group",logical_operator:"and",nodes}
    : {type:"terminal",service:"full_text",parameters:{value:"enzyme"}};
  const opts = {paginate:{start:0,rows:25}};
  if (text.trim()) opts.sort = [{sort_by:"score",direction:"descending"}];
  return {query:q, return_type:"entry", request_options:opts};
};

const buildUniprotQuery = (acc, f={}) => {
  const nodes = [
    {type:"terminal",service:"text",parameters:{attribute:"rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession",operator:"exact_match",value:acc.trim().toUpperCase()}},
    {type:"terminal",service:"text",parameters:{attribute:"rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_name",operator:"exact_match",value:"UniProt"}},
  ];
  if (f.maxRes)        nodes.push({type:"terminal",service:"text",parameters:{attribute:"rcsb_entry_info.resolution_combined",operator:"less_or_equal",value:parseFloat(f.maxRes)}});
  if (f.method)        nodes.push({type:"terminal",service:"text",parameters:{attribute:"exptl.method",operator:"exact_match",value:f.method}});
  if (f.ligand&&f.ligand.trim()) nodes.push({type:"terminal",service:"text",parameters:{attribute:"rcsb_nonpolymer_entity_container_identifiers.comp_id",operator:"exact_match",value:f.ligand.trim().toUpperCase()}});
  // return_type "polymer_entity" es obligatorio al filtrar por atributos de entidad polímero (UniProt).
  // Devuelve IDs tipo "4ZUD_1" que luego se recortan a "4ZUD".
  return {query:{type:"group",logical_operator:"and",nodes}, return_type:"polymer_entity", request_options:{paginate:{start:0,rows:50}}};
};

const fetchDetails = async ids => {
  const list = await Promise.all(ids.map(async id => {
    try {
      const r = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${id}`);
      if (!r.ok) return {rcsb_id:id};
      const j = await r.json();
      // Try to get organism from polymer entities separately
      let organism = null;
      try {
        const re = await fetch(`https://data.rcsb.org/rest/v1/core/polymer_entity/${id}/1`);
        if (re.ok) {
          const je = await re.json();
          organism = je?.rcsb_entity_source_organism?.[0]?.ncbi_scientific_name || null;
        }
      } catch {}
      return {
        rcsb_id: id,
        struct: j.struct,
        rcsb_entry_info: j.rcsb_entry_info,
        exptl: j.exptl,
        polymer_entities: organism ? [{rcsb_entity_source_organism:[{ncbi_scientific_name:organism}]}] : [],
      };
    } catch { return {rcsb_id:id}; }
  }));
  return list.reduce((acc,e)=>{acc[e.rcsb_id]=e;return acc},{});
};

/* ═══════════════════════════════════════════════════════════
   VALIDACIÓN CRISTALOGRÁFICA (PDBe + RCSB)
   Basado en: Warren et al. 2012 (Iridium), Deller & Rupp 2015.
   La resolución es CANTIDAD, no calidad. Los criterios decisivos son
   R-free, error de coordenadas, y el ajuste local del ligando (RSCC/RSR).
═══════════════════════════════════════════════════════════ */
const PDBE = "https://www.ebi.ac.uk/pdbe/api"; // (reservado para futuras métricas locales)

// Promise con timeout para que un endpoint lento no congele la app
const fetchJSON = async (url, ms=12000) => {
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try {
    const r = await fetch(url, {signal:ctrl.signal});
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { clearTimeout(t); return null; }
};

/* Nivel 1 — Calidad global del modelo (R-free, R-work, resolución).
   Fuente: RCSB Data API (objeto `refine` del entry), CORS-friendly.
   IMPORTANTE: los campos del diccionario PDBx/mmCIF en RCSB conservan mayúsculas:
   ls_R_factor_R_free, ls_R_factor_R_work (no minúsculas). */
const fetchGlobalQuality = async id => {
  const out = {rfree:null, rwork:null, resolution:null, hasSF:null,
               clashscore:null, ramaOutliers:null, rsrzOutliers:null,
               bondsRMSZ:null, anglesRMSZ:null};
  const j = await fetchJSON(`https://data.rcsb.org/rest/v1/core/entry/${id.toUpperCase()}`);
  if (!j) return out;

  // Refinamiento: R-free, R-work (campos con R mayúscula)
  const ref = Array.isArray(j.refine) ? j.refine[0] : j.refine;
  if (ref) {
    out.rfree = ref.ls_R_factor_R_free!=null ? parseFloat(ref.ls_R_factor_R_free) : null;
    out.rwork = ref.ls_R_factor_R_work!=null ? parseFloat(ref.ls_R_factor_R_work)
              : (ref.ls_R_factor_obs!=null ? parseFloat(ref.ls_R_factor_obs) : null);
  }

  // Resolución
  out.resolution = j.rcsb_entry_info?.resolution_combined?.[0]
                ?? (Array.isArray(j.refine) ? j.refine[0]?.ls_d_res_high : null)
                ?? j.rcsb_entry_info?.diffrn_resolution_high?.value
                ?? null;
  if (out.resolution!=null) out.resolution = parseFloat(out.resolution);

  // ¿Factores de estructura depositados?
  out.hasSF = j.pdbx_database_status?.status_code_sf === "REL"
           || j.rcsb_accession_info?.has_released_experimental_data === "Y"
           || null;

  // Métricas de validación ya calculadas por RCSB (objeto pdbx_vrpt_summary_geometry)
  const geo = Array.isArray(j.pdbx_vrpt_summary_geometry) ? j.pdbx_vrpt_summary_geometry[0] : j.pdbx_vrpt_summary_geometry;
  if (geo) {
    out.clashscore   = geo.clashscore ?? null;
    out.ramaOutliers = geo.percent_ramachandran_outliers ?? null;
    out.bondsRMSZ    = geo.bonds_RMSZ ?? null;
    out.anglesRMSZ   = geo.angles_RMSZ ?? null;
  }
  const dif = Array.isArray(j.pdbx_vrpt_summary_diffraction) ? j.pdbx_vrpt_summary_diffraction[0] : j.pdbx_vrpt_summary_diffraction;
  if (dif) {
    out.rsrzOutliers = dif.percent_RSRZ_outliers ?? null;
    // Si por alguna razón no vino R-free del refine, usar el de DCC
    if (out.rfree==null && dif.DCC_Rfree!=null) out.rfree = parseFloat(dif.DCC_Rfree);
  }
  return out;
};

/* Nivel 2 — Calidad local del ligando co-cristalizado (RSCC, RSR).
   Fuente: RCSB Data API. El score de validación del ligando vive en el endpoint
   de INSTANCIA non-polymer (nonpolymer_entity_instance/{ID}/{asym_id}), en el campo
   rcsb_nonpolymer_instance_validation_score. Para llegar ahí hay que resolver primero
   los asym_id de instancia de cada entidad non-polymer cuyo comp_id sea el ligando buscado. */
const fetchLigandQuality = async (id, ligCode) => {
  const ID = id.toUpperCase();
  const out = {rscc:null, rsr:null, rsrz:null, bfactor:null, occupancy:null,
               flagged:false, hasData:false, ranking:null, intermolClashes:null, triedInstances:0};

  // 1. Obtener los entity_ids non-polymer del entry
  const entry = await fetchJSON(`https://data.rcsb.org/rest/v1/core/entry/${ID}`);
  const npEntityIds = entry?.rcsb_entry_container_identifiers?.non_polymer_entity_ids || [];

  // 2. Por cada entidad non-polymer, ver si su comp_id coincide con el ligando,
  //    y obtener sus asym_ids de instancia.
  const targetAsymIds = [];
  for (const eid of npEntityIds) {
    const ent = await fetchJSON(`https://data.rcsb.org/rest/v1/core/nonpolymer_entity/${ID}/${eid}`);
    const comp = ent?.pdbx_entity_nonpoly?.comp_id
              || ent?.rcsb_nonpolymer_entity_container_identifiers?.nonpolymer_comp_id
              || ent?.rcsb_nonpolymer_entity?.pdbx_description
              || null;
    if (comp && comp !== ligCode) continue;
    // asym_ids de instancia de esta entidad
    const asymIds = ent?.rcsb_nonpolymer_entity_container_identifiers?.asym_ids
                 || ent?.rcsb_nonpolymer_entity_container_identifiers?.auth_asym_ids
                 || [];
    asymIds.forEach(a=>targetAsymIds.push(a));
  }

  // Fallback: si no se resolvieron instancias por entidad, probar asym_ids comunes
  const candidates = targetAsymIds.length ? targetAsymIds : ["A","B","C","D"];

  // 3. Consultar el score de validación de cada instancia candidata
  for (const asymId of candidates) {
    out.triedInstances++;
    const inst = await fetchJSON(`https://data.rcsb.org/rest/v1/core/nonpolymer_entity_instance/${ID}/${asymId}`);
    if (!inst) continue;
    const comp = inst?.rcsb_nonpolymer_entity_instance_container_identifiers?.comp_id || null;
    if (comp && comp !== ligCode) continue;

    const vs = inst?.rcsb_nonpolymer_instance_validation_score;
    const arr = Array.isArray(vs) ? vs : (vs?[vs]:[]);
    // Elegir la entrada con mejor (mayor) RSCC si hay varias
    let best=null;
    for (const v of arr) {
      if (v.RSCC!=null && (best==null || parseFloat(v.RSCC)>parseFloat(best.RSCC||-1))) best=v;
      else if (best==null) best=v;
    }
    if (best) {
      out.hasData = true;
      if (best.RSCC!=null)              out.rscc = parseFloat(best.RSCC);
      if (best.RSR!=null)               out.rsr  = parseFloat(best.RSR);
      if (best.RSRZ!=null)              out.rsrz = parseFloat(best.RSRZ);
      if (best.ranking_model_fit!=null) out.ranking = parseFloat(best.ranking_model_fit);
      if (best.average_occupancy!=null) out.occupancy = parseFloat(best.average_occupancy);
      if (best.intermolecular_clashes!=null) out.intermolClashes = best.intermolecular_clashes;
      if (best.mogul_bond_RMSZ!=null)   out.bfactor = null; // placeholder
      break;
    }
  }

  // 4. Bandera según criterio wwPDB actual: RSR > 0.4 o RSCC < 0.8
  if (out.rsr!=null && out.rsr > 0.4)  out.flagged = true;
  if (out.rscc!=null && out.rscc < 0.8) out.flagged = true;
  return out;
};

/* Veredicto combinado jerárquico.
   Una estructura NO puede ser "óptima" si falla Nivel 1 (datos no confiables)
   o Nivel 2 (RSCC<0.8). El CNN score (Nivel 3) confirma, no rescata. */
const receptorVerdict = (q, lig, gnina) => {
  // q: global quality, lig: ligand quality, gnina: {cnn, rmsd}
  const flags = [];
  let tier = "ok"; // ok | caution | reject | unknown

  // Nivel 1
  if (q) {
    if (q.rfree!=null && q.rwork!=null && (q.rfree - q.rwork) > 0.05)
      flags.push({lvl:"R-free − R-work > 0.05 (sobreajuste)", sev:"caution"});
    if (q.rfree!=null && q.rfree > 0.45)
      flags.push({lvl:"R-free > 0.45", sev:"reject"});
    if (q.rfree!=null && q.rfree > 0.28 && q.rfree <= 0.45)
      flags.push({lvl:"R-free elevado", sev:"caution"});
  }
  // Nivel 2 — lo más decisivo para docking
  if (lig && lig.hasData) {
    if (lig.rscc!=null && lig.rscc < 0.8)
      flags.push({lvl:`RSCC del ligando ${lig.rscc.toFixed(2)} < 0.8 (mal soportado)`, sev:"reject"});
    else if (lig.rscc!=null && lig.rscc < 0.9)
      flags.push({lvl:`RSCC del ligando ${lig.rscc.toFixed(2)} (dudoso)`, sev:"caution"});
    if (lig.rsr!=null && lig.rsr > 0.4)
      flags.push({lvl:`RSR del ligando ${lig.rsr.toFixed(2)} > 0.4`, sev:"caution"});
  }
  // Determinar tier por la peor bandera
  if (flags.some(f=>f.sev==="reject")) tier = "reject";
  else if (flags.some(f=>f.sev==="caution")) tier = "caution";
  else if ((q && q.rfree!=null) || (lig && lig.hasData)) tier = "ok";
  else tier = "unknown";

  // Nivel 3 confirma (no rescata)
  let cnnNote = null;
  if (gnina && gnina.cnn!=null) {
    if (gnina.cnn >= 0.9) cnnNote = "CNN ≥ 0.9: receptor de alta calidad para docking";
    else if (gnina.cnn >= 0.5) cnnNote = "CNN 0.5–0.9: aceptable con precaución";
    else cnnNote = "CNN < 0.5: sitio probablemente ocluido";
  }
  return {tier, flags, cnnNote};
};

const tierColor = t => t==="ok"?"#34d399":t==="caution"?"#fbbf24":t==="reject"?"#f87171":"#4a6a8a";
const tierLabel = t => t==="ok"?"Apto":t==="caution"?"Precaución":t==="reject"?"No recomendado":"Sin datos";

/* ═══════════════════════════════════════════════════════════
   PROCESAMIENTO PDB
═══════════════════════════════════════════════════════════ */
const PDB = {
  clean: txt => txt.split("\n").filter(l=>["HEADER","TITLE","REMARK","SEQRES","ATOM","TER","END"].includes(l.substring(0,6).trim())).join("\n"),
  ligand: (txt,code) => {
    const ls = txt.split("\n").filter(l=>l.substring(0,6).trim()==="HETATM"&&l.substring(17,20).trim()===code);
    return ls.length?`REMARK  Ligand ${code}\nREMARK  Add H before docking\n${ls.join("\n")}\nEND`:null;
  },
  centroid: (txt,code) => {
    const pts = txt.split("\n")
      .filter(l=>l.substring(0,6).trim()==="HETATM"&&(!code||l.substring(17,20).trim()===code))
      .map(l=>[parseFloat(l.substring(30,38)),parseFloat(l.substring(38,46)),parseFloat(l.substring(46,54))])
      .filter(p=>!isNaN(p[0]));
    if(!pts.length) return null;
    const n=pts.length,cx=pts.reduce((s,p)=>s+p[0],0)/n,cy=pts.reduce((s,p)=>s+p[1],0)/n,cz=pts.reduce((s,p)=>s+p[2],0)/n;
    const mr=Math.max(...pts.map(p=>Math.sqrt((p[0]-cx)**2+(p[1]-cy)**2+(p[2]-cz)**2)));
    return {x:cx.toFixed(3),y:cy.toFixed(3),z:cz.toFixed(3),n,mr:mr.toFixed(1),box:Math.min(Math.max(Math.round((mr*2+10)/2)*2,16),30)};
  },
  ligs: txt => {const s=new Set();txt.split("\n").forEach(l=>{if(l.substring(0,6).trim()==="HETATM")s.add(l.substring(17,20).trim())});return[...s].filter(c=>!SOLVENTS.has(c))},
  fetch: async id => {
    const url = `${RCSB.search}?json=${encodeURIComponent(JSON.stringify({dummy:true}))}`;
    const r = await fetch(RCSB.file(id));
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  },
};
const dlFile=(name,content)=>{const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([content],{type:"text/plain"})),download:name});a.click();URL.revokeObjectURL(a.href)};

/* ═══════════════════════════════════════════════════════════
   ANÁLISIS DE INTERACCIONES
═══════════════════════════════════════════════════════════ */
const getEl = name => {
  const n = name.trim().replace(/^\d/,"");
  return n[0]||"X";
};

const classifyContact = (dist, laEl, paEl, paRes) => {
  if (dist<=3.5 && "NO".includes(laEl) && "NO".includes(paEl))
    return {type:"H-bond", col:"#38bdf8"};
  if (dist<=4.0 && ["ARG","LYS"].includes(paRes) && paEl==="N")
    return {type:"Iónico (+)", col:"#f87171"};
  if (dist<=4.0 && ["ASP","GLU"].includes(paRes) && paEl==="O")
    return {type:"Iónico (−)", col:"#fb923c"};
  if (dist<=5.0 && ["PHE","TYR","TRP","HIS"].includes(paRes))
    return {type:"π / Aromático", col:"#a78bfa"};
  if (dist<=4.5 && laEl==="C" && paEl==="C")
    return {type:"Hidrofóbico", col:"#fbbf24"};
  return {type:"Van der Waals", col:"#4a6a8a"};
};

const parseInteractions = (pdbText, ligCode) => {
  const protAtoms=[], ligAtoms=[];
  pdbText.split("\n").forEach(l => {
    const rec = l.substring(0,6).trim();
    const el  = (l.substring(76,78).trim()||getEl(l.substring(12,16))).toUpperCase();
    if(el==="H") return;
    const x=parseFloat(l.substring(30,38));
    if(isNaN(x)) return;
    const atom={name:l.substring(12,16).trim(),resName:l.substring(17,20).trim(),chain:l.substring(21,22).trim(),
      resNum:l.substring(22,26).trim(),x,y:parseFloat(l.substring(38,46)),z:parseFloat(l.substring(46,54)),el};
    if(rec==="ATOM") protAtoms.push(atom);
    else if(rec==="HETATM"&&atom.resName===ligCode) ligAtoms.push(atom);
  });
  const byRes = new Map();
  for(const la of ligAtoms){
    for(const pa of protAtoms){
      const dist=Math.sqrt((la.x-pa.x)**2+(la.y-pa.y)**2+(la.z-pa.z)**2);
      if(dist>5.0) continue;
      const key=`${pa.resName}${pa.resNum}${pa.chain}`;
      const {type,col}=classifyContact(dist,la.el,pa.el,pa.resName);
      const ex=byRes.get(key);
      if(!ex||dist<parseFloat(ex.dist))
        byRes.set(key,{resName:pa.resName,chain:pa.chain,resNum:parseInt(pa.resNum),
          protAtom:pa.name,ligAtom:la.name,dist:dist.toFixed(2),type,col});
    }
  }
  return [...byRes.values()].sort((a,b)=>parseFloat(a.dist)-parseFloat(b.dist));
};

const makeInteractionSVG = (contacts, ligCode) => {
  const items = contacts.slice(0,14);
  if(!items.length) return "";
  const W=520,H=520,cx=260,cy=260,R=185,rN=28;
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0c1827" rx="10"/>`;
  // Lines
  items.forEach((c,i)=>{
    const a=(2*Math.PI*i/items.length)-Math.PI/2;
    const nx=cx+R*Math.cos(a),ny=cy+R*Math.sin(a);
    const dash=c.type==="H-bond"?"stroke-dasharray='8,4'":c.type==="Van der Waals"?"stroke-dasharray='3,3'":"";
    svg+=`<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${c.col}" stroke-width="1.5" opacity="0.5" ${dash}/>`;
    const mx=(cx+nx)/2,my=(cy+ny)/2;
    svg+=`<text x="${mx}" y="${my}" fill="${c.col}" font-size="9" text-anchor="middle" dy="-4" opacity="0.9" font-family="monospace">${c.dist}Å</text>`;
  });
  // Center ligand
  const hex=Array.from({length:6},(_,i)=>{const a=i*Math.PI/3;return`${cx+34*Math.cos(a)},${cy+34*Math.sin(a)}`;}).join(" ");
  svg+=`<polygon points="${hex}" fill="#fbbf24" fill-opacity="0.15" stroke="#fbbf24" stroke-width="2"/>`;
  svg+=`<text x="${cx}" y="${cy}" fill="#fbbf24" font-size="13" text-anchor="middle" dy="-5" font-weight="bold" font-family="sans-serif">${ligCode}</text>`;
  svg+=`<text x="${cx}" y="${cy}" fill="#fbbf24" font-size="9" text-anchor="middle" dy="9" opacity="0.6" font-family="sans-serif">ligando</text>`;
  // Residue nodes
  items.forEach((c,i)=>{
    const a=(2*Math.PI*i/items.length)-Math.PI/2;
    const nx=cx+R*Math.cos(a),ny=cy+R*Math.sin(a);
    svg+=`<circle cx="${nx}" cy="${ny}" r="${rN}" fill="${c.col}" fill-opacity="0.12" stroke="${c.col}" stroke-width="1.5"/>`;
    svg+=`<text x="${nx}" y="${ny}" fill="${c.col}" font-size="10" text-anchor="middle" dy="-7" font-weight="bold" font-family="sans-serif">${c.resName}</text>`;
    svg+=`<text x="${nx}" y="${ny}" fill="${c.col}" font-size="9" text-anchor="middle" dy="5" font-family="monospace">${c.resNum}${c.chain}</text>`;
    svg+=`<text x="${nx}" y="${ny}" fill="${c.col}" font-size="7.5" text-anchor="middle" dy="16" opacity="0.8" font-family="monospace">${c.protAtom}</text>`;
  });
  // Legend
  const types=[...new Set(items.map(c=>c.type))];
  const typeMap={"H-bond":"#38bdf8","Iónico (+)":"#f87171","Iónico (−)":"#fb923c","π / Aromático":"#a78bfa","Hidrofóbico":"#fbbf24","Van der Waals":"#4a6a8a"};
  svg+=`<text x="10" y="${H-14-types.length*16}" fill="#7a9ec0" font-size="9" font-family="sans-serif">Tipo de interacción:</text>`;
  types.forEach((t,i)=>{const col=typeMap[t]||"#7a9ec0";svg+=`<circle cx="15" cy="${H-6-i*14}" r="4" fill="${col}"/><text x="24" y="${H-2-i*14}" fill="${col}" font-size="9" font-family="sans-serif">${t}</text>`;});
  svg+=`</svg>`;
  return svg;
};

/* ═══════════════════════════════════════════════════════════
   CSV / ZIP
═══════════════════════════════════════════════════════════ */
const generateCSV = (selArr, entries, scores, calcOverall) => {
  const h = ["PDB ID","Resolución","Organismo","Ligandos",
    "DOG D-Score","DOG Vol Å³","DOG Prof Å","DOG Hidrofob",
    "FPW Drug Score","FPW Vol Å³","FPW Polaridad","FPW # Res",
    "CASTp SA Área Å²","CASTp SA Vol Å³","CASTp MS Área Å²","CASTp MS Vol Å³","Score Global"].join(",");
  const rows = selArr.map(id=>{
    const e=entries[id]||{},sc=scores[id]||{};
    return [id,getRes(e).replace(" Å",""),`"${getOrg(e)}"`,`"${getLigs(e).join(";")}"`
      ,sc.dogsite?.score||"",sc.dogsite?.vol||"",sc.dogsite?.depth||"",sc.dogsite?.hydro||""
      ,sc.fpocket?.score||"",sc.fpocket?.vol||"",sc.fpocket?.polarity||"",sc.fpocket?.nres||""
      ,sc.castp?.saArea||"",sc.castp?.saVol||"",sc.castp?.msArea||"",sc.castp?.msVol||""
      ,calcOverall(id)||""].join(",");
  });
  return [h,...rows].join("\n");
};

const runZip = async (id, entry, ligCode, pdbText, selArr, entries, scores, calcOverall) => {
  await loadScript(JSZIP_URL);
  const zip = new window.JSZip();
  const folder = zip.folder(id);
  folder.file(`${id}_protein_clean.pdb`, PDB.clean(pdbText));
  if(ligCode){
    const lig=PDB.ligand(pdbText,ligCode);
    if(lig) folder.file(`${id}_${ligCode}_ligand.pdb`,lig);
    const cent=PDB.centroid(pdbText,ligCode);
    if(cent) folder.file(`${id}_${ligCode}_vina_config.txt`,
      `# Config AutoDock Vina\n# ${id} | Ligando: ${ligCode}\nreceptor = ${id}_protein_prep.pdbqt\nligand = ${ligCode}_prep.pdbqt\ncenter_x = ${cent.x}\ncenter_y = ${cent.y}\ncenter_z = ${cent.z}\nsize_x = ${cent.box}\nsize_y = ${cent.box}\nsize_z = ${cent.box}\nexhaustiveness = 16\nnum_modes = 10\nenergy_range = 3\n`);
  }
  folder.file("druggability_scores.csv", generateCSV(selArr,entries,scores,calcOverall));
  folder.file("README.txt",
    `PDB Drug Discovery Workstation — Paquete de docking\nEstructura: ${id}\nTítulo: ${entry?.struct?.title||""}\n\nArchivos:\n- ${id}_protein_clean.pdb: Proteína (solo ATOM)\n- ${id}_${ligCode}_ligand.pdb: Ligando sin H\n- ${id}_${ligCode}_vina_config.txt: Caja AutoDock Vina\n- druggability_scores.csv: Puntuaciones de todas las estructuras seleccionadas\n\nPasos antes del docking:\n1. Agregar H a proteína (PDB2PQR / AutoDockTools)\n2. Agregar H a ligando (Open Babel / RDKit)\n3. Convertir a PDBQT\n4. Verificar caja en PyMOL\n`);
  const blob = await zip.generateAsync({type:"blob"});
  const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`${id}_docking_package.zip`});
  a.click(); URL.revokeObjectURL(a.href);
};

/* ═══════════════════════════════════════════════════════════
   CLAUDE API (opcional)
═══════════════════════════════════════════════════════════ */
const askClaude = async (key,id,entry,ligCode,cent,drugScores) => {
  const centCtx=cent?`Centroide de ${ligCode}: X=${cent.x} Y=${cent.y} Z=${cent.z} Å | Caja: ${cent.box}×${cent.box}×${cent.box} Å`:"Sin centroide";
  const scCtx=Object.entries(drugScores||{}).map(([t,v])=>Object.entries(v||{}).filter(([,x])=>x!=="").map(([k,x])=>`${t}.${k}=${x}`).join(", ")).filter(Boolean).join(" | ")||"Sin puntuaciones";
  const prompt=`Eres experta en SBDD y docking molecular. Analiza en ESPAÑOL:\nPDB: ${id}\nTítulo: ${entry?.struct?.title||"N/A"}\nResolución: ${getRes(entry)} | Método: ${entry?.exptl?.[0]?.method||"N/A"}\nOrganismo: ${getOrg(entry)}\nLigandos: ${getLigs(entry).join(", ")||"N/A"}\n${centCtx}\nDruggability: ${scCtx}\n\nSecciones en negrita:\n**CALIDAD ESTRUCTURAL**\n**PREPARACIÓN DEL RECEPTOR**\n**SITIO DE UNIÓN**\n**PARÁMETROS DE DOCKING** (valores concretos)\n**VALIDACIÓN**\n**CONSIDERACIONES CRÍTICAS**\n**FARMACOFORO**`;
  const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body:JSON.stringify({model:"claude-opus-4-5",max_tokens:1500,messages:[{role:"user",content:prompt}]})});
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error?.message||`HTTP ${r.status}`);}
  const d=await r.json();
  return d.content?.[0]?.text||"Sin respuesta.";
};

/* ═══════════════════════════════════════════════════════════
   HELPERS UI
═══════════════════════════════════════════════════════════ */
const scoreCol=v=>{const n=parseFloat(v);return isNaN(n)?"#4a6a8a":n>=0.7?"#34d399":n>=0.5?"#fbbf24":"#f87171"};
const getOrg=e=>e?.polymer_entities?.[0]?.rcsb_entity_source_organism?.[0]?.ncbi_scientific_name||"—";
const getRes=e=>{const r=e?.rcsb_entry_info?.resolution_combined;return r?`${parseFloat(r).toFixed(2)} Å`:"—"};
const getLigs=e=>(e?.rcsb_entry_info?.nonpolymer_bound_components||[]).filter(c=>!SOLVENTS.has(c));

/* ═══════════════════════════════════════════════════════════
   ESTILOS
═══════════════════════════════════════════════════════════ */
const C={bg:"#070e1a",s1:"#0c1827",s2:"#102035",bd:"#1e3a5c",tx:"#dde8f5",txd:"#7a9ec0",txm:"#3d5a77",
  c1:"#38bdf8",c2:"#34d399",c3:"#fbbf24",c4:"#a78bfa",c5:"#f87171",c6:"#fb923c"};
const mono="'Courier New',monospace";
const card={background:C.s1,border:`1px solid ${C.bd}`,borderRadius:10,padding:"1rem"};
const inp={background:C.s2,border:`1px solid ${C.bd}`,borderRadius:7,color:C.tx,padding:"6px 10px",fontSize:13,outline:"none",width:"100%",boxSizing:"border-box"};
const TH={fontSize:11,fontWeight:700,color:C.txd,letterSpacing:"0.07em",padding:"6px 8px",borderBottom:`1px solid ${C.bd}`,textAlign:"left",whiteSpace:"nowrap"};
const TD={fontSize:12,padding:"6px 8px",borderBottom:`1px solid ${C.bd}18`,verticalAlign:"middle"};

const Spin=({c=C.c1,s=15})=><span style={{display:"inline-block",width:s,height:s,border:`2px solid ${c}33`,borderTop:`2px solid ${c}`,borderRadius:"50%",animation:"spin 0.7s linear infinite",verticalAlign:"middle"}}/>;
const Badge=({children,col})=><span style={{background:col+"22",border:`1px solid ${col}44`,color:col,borderRadius:5,padding:"1px 8px",fontSize:11,fontWeight:700}}>{children}</span>;
const Btn=({children,col=C.c1,ghost=false,small=false,full=false,onClick,disabled,style:sx={}})=>(
  <button onClick={onClick} disabled={disabled} style={{background:ghost?"transparent":col+"18",border:`1px solid ${col}${ghost?"33":"55"}`,color:disabled?"#3d5a77":col,borderRadius:7,padding:small?"3px 10px":"6px 14px",fontSize:small?11:13,fontWeight:600,cursor:disabled?"default":"pointer",width:full?"100%":undefined,display:full?"flex":undefined,alignItems:full?"center":undefined,justifyContent:full?"center":undefined,gap:full?6:undefined,...sx}}>
    {children}
  </button>
);

/* ═══════════════════════════════════════════════════════════
   APP PRINCIPAL
═══════════════════════════════════════════════════════════ */
export default function App() {
  useEffect(()=>{
    const s=document.createElement("style");
    s.textContent="@keyframes spin{to{transform:rotate(360deg)}}@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}";
    document.head.appendChild(s);
  },[]);

  /* ── Refs NGL ── */
  const nglRef   = useRef(null);
  const stageRef = useRef(null);

  /* ── State ── */
  const [tab,setTab]             = useState("search");
  const [searchMode,setSearchMode] = useState("text");   // "text" | "uniprot"
  const [query,setQuery]         = useState("");
  const [uniprotQ,setUniprotQ]   = useState("");
  const [filters,setFilters]     = useState({maxRes:"2.5",method:"",ligand:"",species:""});
  const [results,setResults]     = useState([]);
  const [loading,setLoading]     = useState(false);
  const [error,setError]         = useState("");
  const [selected,setSelected]   = useState(new Set());
  const [entries,setEntries]     = useState({});
  const [pdbFiles,setPdbFiles]   = useState({});
  const [pdbLoad,setPdbLoad]     = useState({});
  const [scores,setScores]       = useState({});
  const [cents,setCents]         = useState({});
  const [ligSel,setLigSel]       = useState({});
  const [showF,setShowF]         = useState(true);
  const [apiKey,setApiKey]       = useState("");
  const [aiText,setAiText]       = useState("");
  const [aiLoad,setAiLoad]       = useState(false);
  const [aiFor,setAiFor]         = useState("");
  const [sortDir,setSortDir]     = useState("asc");
  const [viewId,setViewId]       = useState(null);
  const [nglReady,setNglReady]   = useState(false);
  const [nglLoading,setNglLoading] = useState(false);
  const [interactions,setInteractions] = useState({});
  const [interLoad,setInterLoad] = useState({});
  const [zipLoad,setZipLoad]     = useState({});
  const [interTarget,setInterTarget] = useState("");
  const [interLig,setInterLig]   = useState("");
  // Validación cristalográfica (Nivel 1+2) y GNINA (Nivel 3)
  const [valData,setValData]     = useState({});   // {id:{global, ligand}}
  const [valLoad,setValLoad]     = useState({});   // {id:bool}
  const [gnina,setGnina]         = useState({});   // {id:{cnn, rmsd}}
  const [valLigSel,setValLigSel] = useState({});   // {id: ligCode} ligando a evaluar

  /* ── Cargar NGL ── */
  useEffect(()=>{
    loadScript(NGL_URL).then(()=>setNglReady(true)).catch(()=>{});
  },[]);

  /* ── Inicializar visor NGL cuando cambia viewId ── */
  useEffect(()=>{
    if(!nglReady||!nglRef.current) return;
    if(stageRef.current){stageRef.current.dispose();stageRef.current=null;}
    if(!viewId) return;
    setNglLoading(true);
    const stage=new window.NGL.Stage(nglRef.current,{backgroundColor:C.bg});
    stageRef.current=stage;
    fetch(RCSB.file(viewId))
      .then(r=>r.text())
      .then(txt=>{
        stage.loadFile(new Blob([txt],{type:"text/plain"}),{ext:"pdb"}).then(comp=>{
          comp.addRepresentation("cartoon",{color:"chainid",opacity:0.85});
          comp.addRepresentation("licorice",{sele:"hetero and not water",color:"element",scale:2.0});
          stage.autoView();
          setNglLoading(false);
        }).catch(()=>setNglLoading(false));
      }).catch(()=>setNglLoading(false));
    return()=>{if(stageRef.current){stageRef.current.dispose();stageRef.current=null;}};
  },[nglReady,viewId]);

  /* ── overall score ── */
  const overall=useCallback(pid=>{
    const sc=scores[pid]||{};let s=0,w=0;
    const d=parseFloat(sc.dogsite?.score);if(!isNaN(d)){s+=d*0.4;w+=0.4;}
    const f=parseFloat(sc.fpocket?.score);if(!isNaN(f)){s+=f*0.4;w+=0.4;}
    const m=parseFloat(sc.castp?.msVol);if(!isNaN(m)){s+=Math.min(m/1000,1)*0.2;w+=0.2;}
    return w>0?(s/w).toFixed(3):null;
  },[scores]);

  /* ── Cargar validación cristalográfica (Nivel 1 + 2) ── */
  const loadValidation = useCallback(async (id, ligCode) => {
    setValLoad(p=>({...p,[id]:true}));
    try {
      const [global, ligand] = await Promise.all([
        fetchGlobalQuality(id),
        ligCode ? fetchLigandQuality(id, ligCode) : Promise.resolve(null),
      ]);
      // Estado de diagnóstico: ¿llegó algo?
      const status = {
        globalOk: global && (global.rfree!=null || global.resolution!=null),
        ligandOk: ligand && ligand.hasData,
        rfreeOk:  global && global.rfree!=null,
        rsccOk:   ligand && ligand.rscc!=null,
      };
      setValData(p=>({...p,[id]:{global, ligand, ligCode, status}}));
    } catch(e) {
      setValData(p=>({...p,[id]:{global:null, ligand:null, error:e.message}}));
    } finally {
      setValLoad(p=>({...p,[id]:false}));
    }
  },[]);

  // Cargar validación de todas las estructuras seleccionadas (en serie para no saturar la API)
  const loadAllValidation = useCallback(async () => {
    for (const id of [...selected]) {
      const lig = valLigSel[id] || getLigs(entries[id]||{})[0] || null;
      await loadValidation(id, lig);
    }
  },[selected, valLigSel, entries, loadValidation]);

  const setGninaVal = (id, field, value) =>
    setGnina(p=>({...p,[id]:{...(p[id]||{}), [field]: value===""?null:parseFloat(value)}}));

  /* ── Búsqueda texto ── */
  const doSearch=useCallback(async()=>{
    if(!query.trim()&&!filters.ligand&&!filters.species&&!filters.method&&!filters.maxRes)
      {setError("Ingresa al menos un término de búsqueda.");return;}
    setLoading(true);setError("");setResults([]);
    try{
      const url=`${RCSB.search}?json=${encodeURIComponent(JSON.stringify(buildTextQuery(query,filters)))}`;
      const r=await fetch(url);
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j=await r.json();
      const ids=(j.result_set||[]).map(x=>x.identifier);
      if(!ids.length){setError("Sin resultados. Prueba términos más generales.");return;}
      const det=await fetchDetails(ids);
      setResults(ids.map(id=>det[id]||{rcsb_id:id}));
      setEntries(p=>({...p,...det}));
    }catch(e){setError("Error: "+e.message);}
    finally{setLoading(false);}
  },[query,filters]);

  /* ── Búsqueda UniProt ── */
  const doUniprotSearch=useCallback(async()=>{
    if(!uniprotQ.trim()){setError("Ingresa un acceso UniProt (ej: Q9BYF1).");return;}
    setLoading(true);setError("");setResults([]);
    try{
      const url=`${RCSB.search}?json=${encodeURIComponent(JSON.stringify(buildUniprotQuery(uniprotQ,filters)))}`;
      const r=await fetch(url);
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const j=await r.json();
      // IDs vienen como "4ZUD_1" (entity); recortar a entry y deduplicar.
      const ids=[...new Set((j.result_set||[]).map(x=>x.identifier.split("_")[0]))];
      if(!ids.length){setError("Sin resultados para ese acceso UniProt.");return;}
      const det=await fetchDetails(ids);
      setResults(ids.map(id=>det[id]||{rcsb_id:id}));
      setEntries(p=>({...p,...det}));
    }catch(e){setError("Error: "+e.message);}
    finally{setLoading(false);}
  },[uniprotQ]);

  /* ── Selección ── */
  const togSel=id=>setSelected(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});

  /* ── PDB ── */
  const ensurePDB=async id=>{
    if(pdbFiles[id]) return pdbFiles[id];
    setPdbLoad(p=>({...p,[id]:true}));
    try{const r=await fetch(RCSB.file(id));if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const t=await r.text();setPdbFiles(p=>({...p,[id]:t}));return t;}
    finally{setPdbLoad(p=>({...p,[id]:false}));}
  };
  const dlProt=async id=>{try{dlFile(`${id}_protein_clean.pdb`,PDB.clean(await ensurePDB(id)))}catch(e){alert(e.message)}};
  const dlLig=async(id,code)=>{try{const l=PDB.ligand(await ensurePDB(id),code);l?dlFile(`${id}_${code}.pdb`,l):alert(`${code} no encontrado`)}catch(e){alert(e.message)}};
  const calcCent=async(id,code)=>{try{const c=PDB.centroid(await ensurePDB(id),code);if(!c){alert("Sin átomos de "+code);return;}setCents(p=>({...p,[id]:{...p[id],[code]:c}}))}catch(e){alert(e.message)}};

  /* ── Scores ── */
  const setScore=(pid,tid,fk,val)=>setScores(p=>({...p,[pid]:{...p[pid],[tid]:{...(p[pid]?.[tid]||{}),[fk]:val}}}));

  /* ── ZIP ── */
  const doZip=async id=>{
    const ligs=getLigs(entries[id]||{});
    const code=ligSel[id]||ligs[0]||"";
    setZipLoad(p=>({...p,[id]:true}));
    try{
      const txt=await ensurePDB(id);
      await runZip(id,entries[id],code,txt,[...selected],entries,scores,overall);
    }catch(e){alert("Error al generar ZIP: "+e.message);}
    finally{setZipLoad(p=>({...p,[id]:false}));}
  };

  /* ── Interacciones ── */
  const calcInteractions=async(id,code)=>{
    if(!code){alert("Selecciona un ligando primero.");return;}
    setInterLoad(p=>({...p,[id]:true}));
    try{
      const txt=await ensurePDB(id);
      const contacts=parseInteractions(txt,code);
      setInteractions(p=>({...p,[id]:{...p[id],[code]:contacts}}));
      setInterTarget(id);setInterLig(code);
    }catch(e){alert("Error: "+e.message);}
    finally{setInterLoad(p=>({...p,[id]:false}));}
  };

  /* ── IA ── */
  const doAI=async id=>{
    if(!apiKey.trim()){alert("Ingresa tu API key de Anthropic en la pestaña Asesoría IA.");setTab("ai");return;}
    setAiFor(id);setAiLoad(true);setAiText("");setTab("ai");
    const e=entries[id],l=ligSel[id]||getLigs(e)[0]||"",c=cents[id]?.[l];
    try{setAiText(await askClaude(apiKey,id,e,l,c,scores[id]));}
    catch(e){setAiText("Error: "+e.message);}
    finally{setAiLoad(false);}
  };

  const selArr=[...selected];
  const sorted=[...results].sort((a,b)=>{
    const va=parseFloat(a?.rcsb_entry_info?.resolution_combined)||999;
    const vb=parseFloat(b?.rcsb_entry_info?.resolution_combined)||999;
    return sortDir==="asc"?va-vb:vb-va;
  });

  const TABS=[
    {id:"search",  l:"Búsqueda PDB"},
    {id:"analysis",l:`Selección de Receptor${selArr.length?` (${selArr.length})`:""}`},
    {id:"download", l:"Descarga"},
    {id:"inter",   l:"Interacciones"},
    {id:"ai",      l:"Asesoría IA"},
  ];

  /* ══════════════════════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════════════════════ */
  return (
    <div style={{background:C.bg,minHeight:"100vh",color:C.tx,fontFamily:"system-ui,sans-serif"}}>

      {/* ── Header ── */}
      <div style={{background:C.s1,borderBottom:`1px solid ${C.bd}`,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:17,fontWeight:700,color:C.c1,letterSpacing:"0.04em"}}>PDB Drug Discovery Workstation</div>
          <div style={{fontSize:10,color:C.txm,letterSpacing:"0.07em"}}>RCSB · DRUGGABILITY · INTERACCIONES · DOCKING IA</div>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          {selArr.slice(0,5).map(id=><Badge key={id} col={C.c1}>{id}</Badge>)}
          {selArr.length>5&&<span style={{fontSize:11,color:C.txd}}>+{selArr.length-5}</span>}
          {selArr.length>0&&<Btn col={C.c5} ghost small onClick={()=>setSelected(new Set())}>✕ Limpiar</Btn>}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{display:"flex",background:C.s1,borderBottom:`1px solid ${C.bd}`,paddingLeft:8,flexWrap:"wrap"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{background:tab===t.id?C.s2:"transparent",border:"none",
              borderBottom:`2px solid ${tab===t.id?C.c1:"transparent"}`,
              color:tab===t.id?C.c1:C.txd,padding:"9px 14px",fontSize:12,fontWeight:600,cursor:"pointer",marginBottom:-1}}>
            {t.l}
          </button>
        ))}
      </div>

      {/* ══════ BÚSQUEDA ══════ */}
      {tab==="search"&&(
        <div style={{padding:14,animation:"fi 0.2s ease"}}>

          {/* Modo de búsqueda */}
          <div style={{display:"flex",gap:6,marginBottom:10,alignItems:"center"}}>
            <Btn col={searchMode==="text"?C.c1:C.txd} ghost={searchMode!=="text"} small onClick={()=>setSearchMode("text")}>🔤 Texto libre</Btn>
            <Btn col={searchMode==="uniprot"?C.c4:C.txd} ghost={searchMode!=="uniprot"} small onClick={()=>setSearchMode("uniprot")}>🔗 UniProt ID</Btn>
          </div>

          {/* Barra de búsqueda texto */}
          {searchMode==="text"&&(
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}
                placeholder='Ej: "angiotensin converting enzyme 2", "CDK2 inhibitor", "HIV protease"'
                style={{...inp,flex:1,padding:"8px 12px",fontSize:14}}/>
              <Btn onClick={doSearch} disabled={loading}>{loading?<Spin/>:"⬡"} Buscar</Btn>
              <Btn col={C.txd} ghost onClick={()=>setShowF(p=>!p)} style={{padding:"8px 12px"}}>{showF?"▲":"▼"}</Btn>
            </div>
          )}

          {/* Barra UniProt */}
          {searchMode==="uniprot"&&(
            <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"flex-start"}}>
              <div style={{flex:1}}>
                <input value={uniprotQ} onChange={e=>setUniprotQ(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&doUniprotSearch()}
                  placeholder="Acceso UniProt (ej: Q9BYF1 para ACE2, P00533 para EGFR)"
                  style={{...inp,padding:"8px 12px",fontSize:14,fontFamily:mono}}/>
                <div style={{fontSize:10,color:C.txm,marginTop:4}}>Formato: 6 caracteres alfanuméricos · Busca todas las estructuras de la proteína en el PDB</div>
              </div>
              <Btn col={C.c4} onClick={doUniprotSearch} disabled={loading}>{loading?<Spin c={C.c4}/>:"🔗"} Buscar UniProt</Btn>
            </div>
          )}

          {/* Filtros (solo en modo texto) */}
          {searchMode==="text"&&showF&&(
            <div style={{...card,marginBottom:12,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12}}>
              <div>
                <div style={{fontSize:10,color:C.txd,fontWeight:700,letterSpacing:"0.07em",marginBottom:4}}>RESOLUCIÓN MÁX (Å)</div>
                <input type="number" min="0.5" max="10" step="0.1" value={filters.maxRes}
                  onChange={e=>setFilters(p=>({...p,maxRes:e.target.value}))} placeholder="2.5" style={inp}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.txd,fontWeight:700,letterSpacing:"0.07em",marginBottom:4}}>TÉCNICA</div>
                <select value={filters.method} onChange={e=>setFilters(p=>({...p,method:e.target.value}))} style={{...inp,cursor:"pointer"}}>
                  <option value="">— Todas —</option>
                  {EXP_METHODS.map(m=><option key={m} value={m}>{m==="X-RAY DIFFRACTION"?"X-Ray":m==="ELECTRON MICROSCOPY"?"Cryo-EM":m.includes("NMR")?"NMR":m}</option>)}
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:C.txd,fontWeight:700,letterSpacing:"0.07em",marginBottom:4}}>LIGANDO (3 letras)</div>
                <input value={filters.ligand} onChange={e=>setFilters(p=>({...p,ligand:e.target.value}))} placeholder="ATP, STI..." style={inp} maxLength={3}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.txd,fontWeight:700,letterSpacing:"0.07em",marginBottom:4}}>ORGANISMO</div>
                <input value={filters.species} onChange={e=>setFilters(p=>({...p,species:e.target.value}))} placeholder="Homo sapiens" style={inp}/>
              </div>
            </div>
          )}

          {error&&<div style={{...card,borderColor:C.c5+"44",color:C.c5,marginBottom:10,fontSize:12}}>{error}</div>}

          {/* Layout: tabla + visor NGL */}
          <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>

            {/* Tabla resultados */}
            <div style={{flex:1,minWidth:0}}>
              {results.length>0&&(
                <div style={card}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,flexWrap:"wrap",gap:8}}>
                    <span style={{fontSize:12,color:C.txd}}>{results.length} resultados · {selected.size} seleccionados</span>
                    <div style={{display:"flex",gap:6}}>
                      <Btn col={C.txd} ghost small onClick={()=>setSortDir(d=>d==="asc"?"desc":"asc")}>Resolución {sortDir==="asc"?"↑":"↓"}</Btn>
                      {selected.size>0&&<Btn col={C.c2} small onClick={()=>setTab("analysis")}>◈ Analizar</Btn>}
                    </div>
                  </div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse"}}>
                      <thead><tr>{["","ID","Título","Res.","Método","Ligandos","Organismo",""].map((h,i)=><th key={i} style={TH}>{h}</th>)}</tr></thead>
                      <tbody>{sorted.map(e=>{
                        const id=e?.rcsb_id,sel=selected.has(id),ligs=getLigs(e);
                        const resN=parseFloat(e?.rcsb_entry_info?.resolution_combined),meth=e?.exptl?.[0]?.method||"";
                        const isViewing=viewId===id;
                        return(
                          <tr key={id} style={{background:isViewing?C.c4+"0d":sel?C.c1+"0d":"transparent",transition:"background 0.1s"}}>
                            <td style={TD}><input type="checkbox" checked={sel} onChange={()=>togSel(id)} style={{accentColor:C.c1,cursor:"pointer"}}/></td>
                            <td style={TD}><a href={RCSB.page(id)} target="_blank" rel="noreferrer" style={{fontFamily:mono,color:C.c1,textDecoration:"none",fontWeight:700,fontSize:12}}>{id}</a></td>
                            <td style={{...TD,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={e?.struct?.title}>{e?.struct?.title||"—"}</td>
                            <td style={{...TD,fontFamily:mono,color:isNaN(resN)?"#4a6a8a":resN<=2?C.c2:resN<=3?C.c3:C.c5}}>{isNaN(resN)?"—":`${resN.toFixed(2)} Å`}</td>
                            <td style={TD}>{meth&&<Badge col={meth==="X-RAY DIFFRACTION"?C.c1:meth.includes("MICROSCOPY")?C.c2:C.c3}>{meth==="X-RAY DIFFRACTION"?"X-RAY":meth.includes("MICROSCOPY")?"cryo-EM":"NMR"}</Badge>}</td>
                            <td style={TD}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{ligs.length?ligs.slice(0,3).map(l=><Badge key={l} col={C.c3}>{l}</Badge>):<span style={{color:C.txm,fontSize:11}}>—</span>}</div></td>
                            <td style={{...TD,fontSize:11,color:C.txd,fontStyle:"italic",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getOrg(e)}</td>
                            <td style={TD}>
                              <div style={{display:"flex",gap:4}}>
                                <Btn col={sel?C.c2:C.c1} ghost small onClick={()=>togSel(id)}>{sel?"✓":"+"}</Btn>
                                <Btn col={isViewing?C.c4:C.txd} ghost={!isViewing} small
                                  onClick={()=>{setViewId(isViewing?null:id);}}>👁</Btn>
                                <Btn col={C.c4} ghost small onClick={()=>doAI(id)}>✦</Btn>
                              </div>
                            </td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </div>
                </div>
              )}
              {!loading&&!error&&!results.length&&(
                <div style={{...card,textAlign:"center",padding:"2.5rem",color:C.txd}}>
                  <div style={{fontSize:32,opacity:.12,marginBottom:10}}>⬡</div>
                  <div style={{fontSize:14,marginBottom:4}}>Busca proteínas en el RCSB PDB</div>
                  <div style={{fontSize:12,color:C.txm}}>Texto libre o UniProt ID (ej: Q9BYF1 para ACE2)</div>
                </div>
              )}
            </div>

            {/* Panel NGL viewer — siempre en DOM, oculto cuando no hay viewId */}
            <div style={{width:viewId?370:0,overflow:"hidden",flexShrink:0,transition:"width 0.3s"}}>
              <div style={{width:370}}>
                {viewId&&(
                  <div style={{...card,borderColor:C.c4+"44",padding:"0.75rem"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div>
                        <span style={{fontFamily:mono,color:C.c1,fontWeight:700,fontSize:13}}>{viewId}</span>
                        <span style={{fontSize:10,color:C.txd,marginLeft:8}}>{getRes(entries[viewId])}</span>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        {nglLoading&&<Spin c={C.c4} s={13}/>}
                        <Btn col={C.c5} ghost small onClick={()=>setViewId(null)}>✕</Btn>
                      </div>
                    </div>
                    <div style={{fontSize:11,color:C.txd,marginBottom:8,lineHeight:1.4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                      {entries[viewId]?.struct?.title||""}
                    </div>
                    {/* NGL canvas */}
                    <div ref={nglRef} style={{width:"100%",height:340,borderRadius:8,overflow:"hidden",background:C.bg}}/>
                    <div style={{fontSize:10,color:C.txm,marginTop:6,textAlign:"center"}}>
                      Arrastra para rotar · Scroll para zoom · Click derecho para trasladar
                    </div>
                  </div>
                )}
                {/* Siempre renderizar el ref aunque viewId sea null */}
                {!viewId&&<div ref={nglRef} style={{display:"none"}}/>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════ DRUGGABILITY ══════ */}
      {tab==="analysis"&&(
        <div style={{padding:14,animation:"fi 0.2s ease"}}>
          {!selArr.length
            ?<div style={{...card,textAlign:"center",padding:"2rem",color:C.txd}}><div style={{fontSize:28,opacity:.1,marginBottom:8}}>◈</div>Selecciona estructuras en Búsqueda primero.</div>
            :<>
              {/* Encabezado + acción de carga */}
              <div style={{...card,marginBottom:12,borderColor:C.c1+"44"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
                  <div style={{flex:1,minWidth:240}}>
                    <div style={{fontWeight:700,fontSize:15,color:C.c1,marginBottom:3}}>Selección de Receptor para Docking</div>
                    <div style={{fontSize:11,color:C.txd,lineHeight:1.6}}>
                      Evaluación jerárquica de calidad. La resolución es <em>cantidad</em>, no calidad
                      (Warren et al. 2012); los criterios decisivos son R-free, el ajuste local del
                      ligando (RSCC/RSR) y la validación funcional por GNINA (Domínguez-Ramírez et al. 2025).
                    </div>
                  </div>
                  <Btn col={C.c2} onClick={loadAllValidation}>
                    ⬇ Cargar métricas de validación
                  </Btn>
                </div>
              </div>

              {/* Tabla jerárquica de selección */}
              <div style={{...card,marginBottom:12}}>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead>
                      <tr>
                        <th style={{...TH,minWidth:62}}>PDB</th>
                        <th style={{...TH,minWidth:70}}>Ligando</th>
                        <th style={{...TH,minWidth:52,color:C.txd}} title="Cantidad, no calidad">Res. (Å)</th>
                        <th style={{...TH,minWidth:60,color:C.c1}} title="R-free < 0.45; idealmente bajo">R-free</th>
                        <th style={{...TH,minWidth:70,color:C.c1}} title="R-free − R-work ≤ 0.05">ΔR (free−work)</th>
                        <th style={{...TH,minWidth:66,color:C.c3}} title="RSCC > 0.9 bueno · 0.8–0.9 dudoso · < 0.8 malo">RSCC lig.</th>
                        <th style={{...TH,minWidth:60,color:C.c3}} title="RSR > 0.4 = bandera">RSR lig.</th>
                        <th style={{...TH,minWidth:78,color:C.c4}} title="CNN score del re-docking del co-cristal (≥ 0.9)">CNN score</th>
                        <th style={{...TH,minWidth:62,color:C.c4}} title="RMSD del re-docking (apoyo)">RMSD</th>
                        <th style={{...TH,minWidth:108}}>Veredicto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selArr.map(id=>{
                        const e=entries[id];
                        const ligs=getLigs(e);
                        const lig=valLigSel[id]||ligs[0]||"";
                        const vd=valData[id];
                        const q=vd?.global, lq=vd?.ligand;
                        const g=gnina[id];
                        const verdict=receptorVerdict(q, lq, g);
                        const loading=valLoad[id];
                        const dR=(q?.rfree!=null&&q?.rwork!=null)?(q.rfree-q.rwork):null;
                        return (
                          <tr key={id}>
                            <td style={{...TD,fontFamily:mono,color:C.c1,fontWeight:700,fontSize:12}}>{id}</td>
                            <td style={TD}>
                              {ligs.length>1
                                ?<select value={lig} onChange={ev=>setValLigSel(p=>({...p,[id]:ev.target.value}))}
                                  style={{...inp,maxWidth:74,padding:"2px 4px",fontSize:11}}>
                                  {ligs.map(l=><option key={l} value={l}>{l}</option>)}
                                </select>
                                :<Badge col={C.c3}>{lig||"—"}</Badge>}
                            </td>
                            <td style={{...TD,fontFamily:mono,fontSize:11,color:C.txd}}>
                              {loading?<Spin s={11}/>:q?.resolution!=null?q.resolution.toFixed(2):"—"}
                            </td>
                            <td style={{...TD,fontFamily:mono,fontSize:12,fontWeight:700,
                              color:q?.rfree==null?C.txm:q.rfree>0.45?C.c5:q.rfree>0.28?C.c3:C.c2}}>
                              {q?.rfree!=null?q.rfree.toFixed(3):"—"}
                            </td>
                            <td style={{...TD,fontFamily:mono,fontSize:12,fontWeight:700,
                              color:dR==null?C.txm:dR>0.05?C.c5:C.c2}}>
                              {dR!=null?dR.toFixed(3):"—"}
                            </td>
                            <td style={{...TD,fontFamily:mono,fontSize:12,fontWeight:700,
                              color:lq?.rscc==null?C.txm:lq.rscc<0.8?C.c5:lq.rscc<0.9?C.c3:C.c2}}>
                              {lq?.rscc!=null?lq.rscc.toFixed(2):lq?.hasData?"n/d":"—"}
                            </td>
                            <td style={{...TD,fontFamily:mono,fontSize:12,fontWeight:700,
                              color:lq?.rsr==null?C.txm:lq.rsr>0.4?C.c5:C.c2}}>
                              {lq?.rsr!=null?lq.rsr.toFixed(2):"—"}
                            </td>
                            <td style={TD}>
                              <input type="number" step="0.01" min="0" max="1"
                                value={g?.cnn??""} placeholder="—"
                                onChange={ev=>setGninaVal(id,"cnn",ev.target.value)}
                                style={{...inp,width:64,padding:"3px 6px",fontSize:11,
                                  borderColor:g?.cnn!=null?(g.cnn>=0.9?C.c2:g.cnn>=0.5?C.c3:C.c5)+"77":C.bd,
                                  color:g?.cnn!=null?(g.cnn>=0.9?C.c2:g.cnn>=0.5?C.c3:C.c5):C.tx}}/>
                            </td>
                            <td style={TD}>
                              <input type="number" step="0.1" min="0"
                                value={g?.rmsd??""} placeholder="Å"
                                onChange={ev=>setGninaVal(id,"rmsd",ev.target.value)}
                                style={{...inp,width:54,padding:"3px 6px",fontSize:11}}/>
                            </td>
                            <td style={TD}>
                              <div style={{display:"flex",alignItems:"center",gap:5}}>
                                <span style={{display:"inline-block",width:9,height:9,borderRadius:"50%",
                                  background:tierColor(verdict.tier),flexShrink:0}}/>
                                <span style={{fontSize:11,fontWeight:700,color:tierColor(verdict.tier)}}>
                                  {tierLabel(verdict.tier)}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{fontSize:10,color:C.txm,marginTop:8,lineHeight:1.6}}>
                  <strong style={{color:C.txd}}>Jerarquía:</strong> una estructura no puede ser óptima si falla el Nivel 1
                  (R-free &gt; 0.45) o el Nivel 2 (RSCC &lt; 0.8), por muy alto que sea su CNN score.
                  Las métricas cristalográficas se obtienen automáticamente del wwPDB/PDBe; CNN score y RMSD se ingresan tras correr GNINA.
                </div>
              </div>

              {/* Detalle de banderas por estructura */}
              {selArr.some(id=>valData[id]) && (
                <div style={{...card,marginBottom:12}}>
                  <div style={{fontWeight:700,fontSize:13,color:C.c1,marginBottom:8}}>Diagnóstico por estructura</div>
                  {selArr.filter(id=>valData[id]).map(id=>{
                    const vd=valData[id], verdict=receptorVerdict(vd.global, vd.ligand, gnina[id]);
                    return (
                      <div key={id} style={{padding:"8px 0",borderBottom:`1px solid ${C.bd}22`}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                          <span style={{fontFamily:mono,color:C.c1,fontWeight:700,fontSize:12}}>{id}</span>
                          <span style={{fontSize:11,fontWeight:700,color:tierColor(verdict.tier)}}>{tierLabel(verdict.tier)}</span>
                          {vd.global?.hasSF===false&&<Badge col={C.c5}>sin factores de estructura</Badge>}
                        </div>
                        {verdict.flags.length===0
                          ?<div style={{fontSize:11,color:C.c2}}>✓ Sin banderas cristalográficas. Estructura confiable para docking.</div>
                          :<div style={{display:"flex",flexDirection:"column",gap:2}}>
                            {verdict.flags.map((f,i)=>(
                              <div key={i} style={{fontSize:11,color:tierColor(f.sev==="reject"?"reject":"caution"),display:"flex",gap:5}}>
                                <span>{f.sev==="reject"?"✕":"⚠"}</span>{f.lvl}
                              </div>
                            ))}
                          </div>}
                        {verdict.cnnNote&&<div style={{fontSize:11,color:C.c4,marginTop:3}}>✦ {verdict.cnnNote}</div>}
                        {vd.ligand && !vd.ligand.hasData && (
                          <div style={{fontSize:10.5,color:C.txm,marginTop:3,fontStyle:"italic"}}>
                            Sin datos de RSCC/RSR para este ligando en el wwPDB (común si no hay factores de estructura,
                            o si el ligando es ion/solvente). El veredicto se basa en las métricas globales disponibles.
                          </div>
                        )}
                        {vd.global && (vd.global.clashscore!=null||vd.global.ramaOutliers!=null) && (
                          <div style={{fontSize:10,color:C.txm,marginTop:4,display:"flex",gap:12,flexWrap:"wrap"}}>
                            {vd.global.clashscore!=null&&<span>Clashscore: <span style={{color:C.txd,fontFamily:mono}}>{vd.global.clashscore}</span></span>}
                            {vd.global.ramaOutliers!=null&&<span>Rama. outliers: <span style={{color:C.txd,fontFamily:mono}}>{vd.global.ramaOutliers}%</span></span>}
                            {vd.global.bondsRMSZ!=null&&<span>RMSZ enlaces: <span style={{color:C.txd,fontFamily:mono}}>{vd.global.bondsRMSZ}</span></span>}
                            {vd.global.anglesRMSZ!=null&&<span>RMSZ ángulos: <span style={{color:C.txd,fontFamily:mono}}>{vd.global.anglesRMSZ}</span></span>}
                            {vd.global.rsrzOutliers!=null&&<span>RSRZ outliers: <span style={{color:C.txd,fontFamily:mono}}>{vd.global.rsrzOutliers}%</span></span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Generador de comando GNINA */}
              <div style={{...card,marginBottom:12,borderColor:C.c4+"44"}}>
                <div style={{fontWeight:700,fontSize:13,color:C.c4,marginBottom:6}}>Comando GNINA — re-docking del co-cristal</div>
                <div style={{fontSize:11,color:C.txd,marginBottom:8,lineHeight:1.6}}>
                  Para validar cada receptor, re-dockea su ligando co-cristalizado y registra el CNN score arriba.
                  El umbral de "docking de alta calidad" es CNN ≥ 0.9 (Domínguez-Ramírez et al. 2025).
                </div>
                {selArr.map(id=>{
                  const lig=valLigSel[id]||getLigs(entries[id]||{})[0]||"LIG";
                  return (
                    <div key={id} style={{marginBottom:6}}>
                      <div style={{fontFamily:mono,background:C.bg,borderRadius:6,padding:"6px 9px",
                        border:`1px solid ${C.bd}`,fontSize:10.5,color:C.c2,overflowX:"auto",whiteSpace:"nowrap"}}>
                        gnina -r {id}_protein_clean.pdb -l {id}_{lig}.pdb --autobox_ligand {id}_{lig}.pdb --cnn_scoring rescore -o {id}_redock.sdf.gz
                      </div>
                    </div>
                  );
                })}
                <div style={{fontSize:10,color:C.txm,marginTop:4}}>
                  Descarga proteína y ligando desde la pestaña Descarga. <code>--autobox_ligand</code> define la caja a partir del co-cristal.
                </div>
                <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${C.bd}`,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:C.txd}}>¿Sin GNINA local?</span>
                  <a href="https://colab.research.google.com/github/Mikel-Ortiz/pdb-workstation/blob/main/pdb-workstation/GNINA_Redocking_Workstation.ipynb" target="_blank" rel="noreferrer"
                    style={{background:C.c4+"18",border:`1px solid ${C.c4}55`,color:C.c4,borderRadius:7,
                      padding:"5px 12px",fontSize:12,fontWeight:600,textDecoration:"none"}}>
                    ▶ Abrir cuaderno GNINA en Colab
                  </a>
                  <span style={{fontSize:10,color:C.txm}}>
                    Re-dockea el co-cristal en GPU gratuita y devuelve CNN score y RMSD listos para copiar aquí.
                  </span>
                </div>
              </div>

              {/* Ranking combinado */}
              {selArr.some(id=>valData[id]||gnina[id]) && (
                <div style={{...card,marginBottom:12,borderColor:C.c2+"44"}}>
                  <div style={{fontWeight:700,color:C.c2,marginBottom:8,fontSize:13}}>◆ Ranking de receptores</div>
                  {selArr
                    .map(id=>({id, v:receptorVerdict(valData[id]?.global, valData[id]?.ligand, gnina[id]), g:gnina[id], lq:valData[id]?.ligand}))
                    .sort((a,b)=>{
                      const ord={ok:0,caution:1,unknown:2,reject:3};
                      if(ord[a.v.tier]!==ord[b.v.tier]) return ord[a.v.tier]-ord[b.v.tier];
                      const ca=a.g?.cnn??-1, cb=b.g?.cnn??-1;
                      if(cb!==ca) return cb-ca;
                      const ra=a.lq?.rscc??-1, rb=b.lq?.rscc??-1;
                      return rb-ra;
                    })
                    .map(({id,v,g,lq},i)=>(
                      <div key={id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:`1px solid ${C.bd}22`}}>
                        <Badge col={i===0?C.c2:i===1?C.c3:C.txd}>#{i+1}</Badge>
                        <span style={{fontFamily:mono,color:C.c1,fontWeight:700,fontSize:12}}>{id}</span>
                        <span style={{fontSize:11,color:C.txd,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entries[id]?.struct?.title||""}</span>
                        {lq?.rscc!=null&&<span style={{fontFamily:mono,fontSize:10,color:lq.rscc<0.8?C.c5:lq.rscc<0.9?C.c3:C.c2}}>RSCC {lq.rscc.toFixed(2)}</span>}
                        {g?.cnn!=null&&<span style={{fontFamily:mono,fontSize:10,color:g.cnn>=0.9?C.c2:g.cnn>=0.5?C.c3:C.c5}}>CNN {g.cnn.toFixed(2)}</span>}
                        <span style={{fontSize:11,fontWeight:700,color:tierColor(v.tier)}}>{tierLabel(v.tier)}</span>
                        <Btn col={C.c4} ghost small onClick={()=>doAI(id)}>✦ IA</Btn>
                      </div>
                    ))}
                </div>
              )}

              {/* Druggability — ahora complementaria */}
              <details style={{...card}}>
                <summary style={{cursor:"pointer",fontWeight:700,fontSize:13,color:C.txd,userSelect:"none"}}>
                  Druggability del bolsillo (criterio complementario)
                </summary>
                <div style={{fontSize:11,color:C.txm,margin:"6px 0 12px",lineHeight:1.6}}>
                  La druggability evalúa la cavidad de forma ligand-agnóstica. Útil como triage inicial,
                  pero subordinada a la calidad cristalográfica y la validación funcional de arriba.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:10,marginBottom:12}}>
                  {TOOLS.map(tool=>(
                    <div key={tool.id} style={{...card,borderColor:tool.col+"44"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}><Badge col={tool.col}>{tool.badge}</Badge><span style={{fontWeight:700,fontSize:14,color:tool.col}}>{tool.name}</span></div>
                      <p style={{fontSize:11,color:C.txd,margin:"0 0 8px",lineHeight:1.5}}>{tool.hint}</p>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {selArr.map(id=><a key={id} href={tool.url(id)} target="_blank" rel="noreferrer"
                          style={{background:tool.col+"18",border:`1px solid ${tool.col}44`,color:tool.col,borderRadius:6,padding:"2px 10px",fontSize:11,fontWeight:600,textDecoration:"none"}}>{id} →</a>)}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse"}}>
                    <thead><tr>
                      <th style={{...TH,minWidth:70}}>PDB ID</th>
                      {TOOLS.map(tool=>tool.fields.map(f=><th key={`${tool.id}-${f.k}`} style={{...TH,color:tool.col,minWidth:80}}>{tool.badge}: {f.l}</th>))}
                      <th style={{...TH,minWidth:85,color:C.c4}}>Score Global</th>
                    </tr></thead>
                    <tbody>{selArr.map(id=>{
                      const ov=overall(id);
                      return(<tr key={id}>
                        <td style={{...TD,fontFamily:mono,color:C.c1,fontWeight:700,fontSize:12}}>{id}</td>
                        {TOOLS.map(tool=>tool.fields.map(f=>{
                          const val=(scores[id]?.[tool.id]?.[f.k])||"";
                          return(<td key={`${tool.id}-${f.k}`} style={TD}>
                            <input type="number" step="0.001" value={val}
                              onChange={ev=>setScore(id,tool.id,f.k,ev.target.value)}
                              placeholder="—"
                              style={{...inp,width:72,padding:"3px 6px",fontSize:11,
                                borderColor:f.s&&val?scoreCol(val)+"77":C.bd,
                                color:f.s&&val?scoreCol(val):C.tx}}/>
                          </td>);
                        }))}
                        <td style={TD}>{ov!=null
                          ?<div style={{textAlign:"center"}}><div style={{fontFamily:mono,fontWeight:700,fontSize:16,color:scoreCol(ov)}}>{ov}</div><div style={{fontSize:9,color:C.txd}}>{parseFloat(ov)>=0.5?"Druggable":"No druggable"}</div></div>
                          :<span style={{color:C.txm}}>—</span>}
                        </td>
                      </tr>);
                    })}</tbody>
                  </table>
                </div>
                <div style={{fontSize:10,color:C.txm,marginTop:6}}>Score = DOG×0.4 + FPW×0.4 + CASTp_msVol_norm×0.2 · Verde ≥ 0.7 · Amarillo ≥ 0.5 · Rojo &lt; 0.5</div>
              </details>
            </>}
        </div>
      )}

      {/* ══════ DESCARGA ══════ */}
      {tab==="download"&&(
        <div style={{padding:14,animation:"fi 0.2s ease",display:"grid",gap:12}}>
          {!selArr.length
            ?<div style={{...card,textAlign:"center",padding:"2rem",color:C.txd}}><div style={{fontSize:28,opacity:.1,marginBottom:8}}>↓</div>Selecciona estructuras en Búsqueda primero.</div>
            :selArr.map(id=>{
              const e=entries[id],ligs=getLigs(e),chosen=ligSel[id]||ligs[0]||"",cent=cents[id]?.[chosen],isLoad=pdbLoad[id];
              return(
                <div key={id} style={{...card,borderColor:C.c1+"33"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontFamily:mono,fontWeight:700,fontSize:18,color:C.c1}}>{id}</span>
                        <Badge col={C.txd}>{getRes(e)}</Badge>
                      </div>
                      <div style={{fontSize:11,color:C.txd,marginTop:2}}>{e?.struct?.title||""}</div>
                      <div style={{fontSize:10,color:C.txm,fontStyle:"italic"}}>{getOrg(e)}</div>
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      <a href={RCSB.page(id)} target="_blank" rel="noreferrer" style={{background:"transparent",border:`1px solid ${C.bd}`,color:C.txd,borderRadius:6,padding:"3px 10px",fontSize:11,textDecoration:"none"}}>Ver RCSB ↗</a>
                      <Btn col={C.c2} onClick={()=>doZip(id)} disabled={zipLoad[id]||isLoad}>
                        {zipLoad[id]?<Spin s={13} c={C.c2}/>:"📦"} Descargar ZIP completo
                      </Btn>
                    </div>
                  </div>
                  <div style={{fontSize:11,color:C.txd,marginBottom:10,padding:"6px 10px",background:C.bg,borderRadius:6,borderLeft:`3px solid ${C.c2}`}}>
                    El ZIP incluye: proteína limpia + ligando + config_vina.txt + <strong style={{color:C.c2}}>druggability_scores.csv</strong> de todas las estructuras seleccionadas.
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:10}}>
                    {/* Proteína */}
                    <div style={{background:C.s2,borderRadius:8,padding:10,border:`1px solid ${C.bd}`}}>
                      <div style={{fontWeight:700,color:C.c1,fontSize:12,marginBottom:4}}>🧬 Proteína Limpia</div>
                      <div style={{fontSize:10,color:C.txd,marginBottom:8}}>Solo ATOM. Sin aguas ni ligandos.</div>
                      <Btn col={C.c1} full onClick={()=>dlProt(id)} disabled={isLoad}>{isLoad?<Spin s={13}/>:"↓"} {id}_protein_clean.pdb</Btn>
                    </div>
                    {/* Ligando */}
                    <div style={{background:C.s2,borderRadius:8,padding:10,border:`1px solid ${C.bd}`}}>
                      <div style={{fontWeight:700,color:C.c3,fontSize:12,marginBottom:4}}>⚗️ Ligando Co-cristal</div>
                      {ligs.length?<>
                        <select value={chosen} onChange={ev=>setLigSel(p=>({...p,[id]:ev.target.value}))} style={{...inp,marginBottom:8,fontSize:12}}>
                          {ligs.map(l=><option key={l} value={l}>{l}</option>)}
                        </select>
                        <div style={{fontSize:10,color:C.txd,marginBottom:8}}>Sin H — agrega con Open Babel.</div>
                        <Btn col={C.c3} full onClick={()=>dlLig(id,chosen)} disabled={isLoad}>{isLoad?<Spin s={13} c={C.c3}/>:"↓"} {id}_{chosen}.pdb</Btn>
                      </>:<div style={{fontSize:11,color:C.txm}}>Sin ligandos detectados.</div>}
                    </div>
                    {/* Centroide */}
                    <div style={{background:C.s2,borderRadius:8,padding:10,border:`1px solid ${C.bd}`}}>
                      <div style={{fontWeight:700,color:C.c2,fontSize:12,marginBottom:4}}>📍 Centro del Ligando</div>
                      {ligs.length?!cent
                        ?<Btn col={C.c2} full onClick={()=>calcCent(id,chosen)} disabled={isLoad}>{isLoad?<Spin s={13} c={C.c2}/>:"⊕"} Calcular centroide de {chosen}</Btn>
                        :<div>
                          <div style={{fontFamily:mono,background:C.bg,borderRadius:6,padding:"6px 8px",border:`1px solid ${C.c2}44`,color:C.c2,marginBottom:6,fontSize:11,lineHeight:1.9}}>
                            X = {cent.x}<br/>Y = {cent.y}<br/>Z = {cent.z}<br/><span style={{color:C.txd}}>N={cent.n} átomos · R_max={cent.mr} Å</span>
                          </div>
                          <div style={{fontFamily:mono,background:C.bg,borderRadius:6,padding:"6px 8px",border:`1px solid ${C.c3}44`,color:C.c3,marginBottom:6,fontSize:10,lineHeight:1.7}}>
                            size_x={cent.box} size_y={cent.box} size_z={cent.box}<br/>center_x={cent.x}<br/>center_y={cent.y}<br/>center_z={cent.z}
                          </div>
                          <Btn col={C.txd} ghost small full
                            onClick={()=>dlFile(`${id}_${chosen}_vina.txt`,`# Config AutoDock Vina\n# ${id} | Ligando: ${chosen}\nreceptor = ${id}_protein_prep.pdbqt\nligand = ${chosen}_prep.pdbqt\ncenter_x = ${cent.x}\ncenter_y = ${cent.y}\ncenter_z = ${cent.z}\nsize_x = ${cent.box}\nsize_y = ${cent.box}\nsize_z = ${cent.box}\nexhaustiveness = 16\nnum_modes = 10\nenergy_range = 3\n`)}>
                            ↓ config_vina.txt
                          </Btn>
                        </div>
                      :<div style={{fontSize:11,color:C.txm}}>Sin ligandos detectados.</div>}
                    </div>
                  </div>
                  <div style={{marginTop:8,padding:"7px 10px",background:C.bg,borderRadius:6,borderLeft:`3px solid ${C.c4}`,fontSize:11,color:C.txd,lineHeight:1.6}}>
                    <span style={{color:C.c4,fontWeight:700}}>Nota experta:</span> La proteína limpia necesita: H + cargas (PDB2PQR/AutoDockTools), loops ausentes (MODELLER), protonación de His/Cys/Asp.{" "}
                    <button onClick={()=>doAI(id)} style={{background:"transparent",border:"none",color:C.c4,cursor:"pointer",fontSize:11,fontWeight:700,padding:"0 4px"}}>✦ Guía IA →</button>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* ══════ INTERACCIONES ══════ */}
      {tab==="inter"&&(
        <div style={{padding:14,animation:"fi 0.2s ease"}}>
          {!selArr.length
            ?<div style={{...card,textAlign:"center",padding:"2rem",color:C.txd}}><div style={{fontSize:28,opacity:.1,marginBottom:8}}>⚛</div>Selecciona estructuras en Búsqueda primero.</div>
            :<>
              {/* Selector */}
              <div style={{...card,marginBottom:12,display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div style={{flex:"1 1 200px"}}>
                  <div style={{fontSize:10,color:C.txd,fontWeight:700,letterSpacing:"0.07em",marginBottom:4}}>ESTRUCTURA</div>
                  <select value={interTarget} onChange={e=>{setInterTarget(e.target.value);setInterLig("");}}
                    style={{...inp,cursor:"pointer"}}>
                    <option value="">— Selecciona —</option>
                    {selArr.map(id=><option key={id} value={id}>{id} — {entries[id]?.struct?.title?.substring(0,40)||""}</option>)}
                  </select>
                </div>
                {interTarget&&(()=>{
                  const ligs=getLigs(entries[interTarget]||{});
                  return(
                    <div style={{flex:"1 1 150px"}}>
                      <div style={{fontSize:10,color:C.txd,fontWeight:700,letterSpacing:"0.07em",marginBottom:4}}>LIGANDO</div>
                      <select value={interLig} onChange={e=>setInterLig(e.target.value)} style={{...inp,cursor:"pointer"}}>
                        <option value="">— Selecciona —</option>
                        {ligs.map(l=><option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  );
                })()}
                <Btn col={C.c2} onClick={()=>calcInteractions(interTarget,interLig)}
                  disabled={!interTarget||!interLig||interLoad[interTarget]}>
                  {interLoad[interTarget]?<Spin c={C.c2} s={13}/>:"⚛"} Calcular interacciones
                </Btn>
              </div>

              {/* Resultados */}
              {interTarget&&interLig&&interactions[interTarget]?.[interLig]&&(()=>{
                const contacts=interactions[interTarget][interLig];
                const svg=makeInteractionSVG(contacts,interLig);
                return(
                  <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:12,alignItems:"start"}}>
                    {/* Tabla */}
                    <div style={card}>
                      <div style={{fontWeight:700,fontSize:14,color:C.c2,marginBottom:3}}>
                        Interacciones proteína–ligando: <span style={{fontFamily:mono}}>{interTarget} · {interLig}</span>
                      </div>
                      <div style={{fontSize:11,color:C.txd,marginBottom:10}}>
                        {contacts.length} residuos en contacto (distancia ≤ 5.0 Å, excluyendo H y solventes)
                      </div>
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse"}}>
                          <thead><tr>
                            {["Residuo","Cadena","Nº","Átomo proteína","Átomo ligando","Dist (Å)","Tipo"].map(h=><th key={h} style={TH}>{h}</th>)}
                          </tr></thead>
                          <tbody>{contacts.map((c,i)=>(
                            <tr key={i} style={{background:i%2===0?"transparent":C.s2+"66"}}>
                              <td style={{...TD,fontFamily:mono,fontWeight:700,color:c.col}}>{c.resName}</td>
                              <td style={{...TD,fontFamily:mono,textAlign:"center"}}>{c.chain}</td>
                              <td style={{...TD,fontFamily:mono,textAlign:"center"}}>{c.resNum}</td>
                              <td style={{...TD,fontFamily:mono,fontSize:11}}>{c.protAtom}</td>
                              <td style={{...TD,fontFamily:mono,fontSize:11,color:C.c3}}>{c.ligAtom}</td>
                              <td style={{...TD,fontFamily:mono,color:parseFloat(c.dist)<=3.5?C.c2:parseFloat(c.dist)<=4.0?C.c3:C.txd,fontWeight:700}}>{c.dist}</td>
                              <td style={TD}><Badge col={c.col}>{c.type}</Badge></td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                      <div style={{marginTop:8,fontSize:10,color:C.txm}}>
                        H-bond ≤ 3.5 Å · Iónico ≤ 4.0 Å · π/Aromático ≤ 5.0 Å · Hidrofóbico ≤ 4.5 Å · Van der Waals ≤ 5.0 Å
                      </div>
                      <div style={{marginTop:8,display:"flex",gap:8}}>
                        <Btn col={C.txd} ghost small
                          onClick={()=>dlFile(`${interTarget}_${interLig}_interactions.csv`,
                            ["Residuo,Cadena,Número,Átomo proteína,Átomo ligando,Distancia Å,Tipo",
                              ...contacts.map(c=>`${c.resName},${c.chain},${c.resNum},${c.protAtom},${c.ligAtom},${c.dist},${c.type}`)].join("\n"))}>
                          ↓ Exportar CSV
                        </Btn>
                        <Btn col={C.txd} ghost small
                          onClick={()=>dlFile(`${interTarget}_${interLig}_interactions.txt`,
                            `Interacciones ${interTarget} · Ligando ${interLig}\n${"─".repeat(60)}\n${contacts.map(c=>`${c.resName.padEnd(4)} ${c.chain} ${String(c.resNum).padStart(4)}  ${c.protAtom.padEnd(5)} ↔ ${c.ligAtom.padEnd(5)}  ${c.dist} Å  ${c.type}`).join("\n")}`)}>
                          ↓ Exportar TXT
                        </Btn>
                      </div>
                    </div>
                    {/* Diagrama SVG */}
                    {svg&&(
                      <div style={{width:280,flexShrink:0}}>
                        <div style={{fontWeight:700,fontSize:13,color:C.c2,marginBottom:8}}>Diagrama de interacciones</div>
                        <div dangerouslySetInnerHTML={{__html:svg}} style={{borderRadius:10,overflow:"hidden"}}/>
                        <div style={{fontSize:10,color:C.txm,marginTop:6,textAlign:"center"}}>Máx 14 residuos más cercanos</div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {interTarget&&interLig&&!interactions[interTarget]?.[interLig]&&(
                <div style={{...card,textAlign:"center",padding:"2rem",color:C.txd}}>
                  <div style={{fontSize:24,opacity:.2,marginBottom:8}}>⚛</div>
                  Haz clic en "Calcular interacciones" para analizar los contactos proteína–{interLig}.
                </div>
              )}
            </>}
        </div>
      )}

      {/* ══════ ASESORÍA IA ══════ */}
      {tab==="ai"&&(
        <div style={{padding:14,animation:"fi 0.2s ease"}}>
          <div style={{...card,marginBottom:12,borderColor:C.c4+"44"}}>
            <div style={{fontWeight:700,color:C.c4,marginBottom:4,fontSize:13}}>✦ API Key de Anthropic</div>
            <div style={{fontSize:11,color:C.txd,marginBottom:8,lineHeight:1.6}}>
              Necesaria para el análisis experto IA. Obtén la tuya en{" "}
              <a href="https://console.anthropic.com/keys" target="_blank" rel="noreferrer" style={{color:C.c1}}>console.anthropic.com/keys</a>.
              Se usa solo localmente.
            </div>
            <input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-ant-..." style={{...inp,fontFamily:mono}}/>
          </div>
          {selArr.length>0&&(
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
              {selArr.map(id=>(
                <Btn key={id} col={id===aiFor?C.c4:C.txd} ghost={id!==aiFor} onClick={()=>doAI(id)} disabled={aiLoad}>
                  {aiLoad&&id===aiFor?<Spin c={C.c4} s={13}/>:null} ✦ Analizar {id}
                </Btn>
              ))}
            </div>
          )}
          {!selArr.length&&<div style={{fontSize:13,color:C.txd,marginBottom:12}}>Selecciona estructuras en Búsqueda primero.</div>}
          {(aiLoad||aiText)&&(
            <div style={{...card,borderColor:C.c4+"44",marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,paddingBottom:8,borderBottom:`1px solid ${C.bd}`}}>
                <Badge col={C.c4}>✦ IA</Badge>
                <span style={{fontWeight:700,color:C.c4}}>Análisis Experto — Docking Molecular</span>
                {aiFor&&<span style={{fontFamily:mono,color:C.c1,fontSize:12}}>{aiFor}</span>}
                {aiLoad&&<Spin c={C.c4}/>}
              </div>
              {aiLoad&&!aiText&&<div style={{color:C.txd,fontSize:13}}>Consultando Claude...</div>}
              {aiText&&(
                <div style={{fontSize:13,lineHeight:1.85,color:C.tx,whiteSpace:"pre-wrap"}}>
                  {aiText.split("**").map((seg,i)=>i%2===0?<span key={i}>{seg}</span>:<strong key={i} style={{color:C.c4}}>{seg}</strong>)}
                </div>
              )}
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:8}}>
            {[
              {col:C.c1,title:"Preparación del receptor",items:["Protonate3D/PDB2PQR para pH 7.4","Aguas > 5 Å del sitio → eliminar","Conservar aguas puente y metales","Loops ausentes: MODELLER/Swiss-Model","Minimizar con MMFF94 o AMBER"]},
              {col:C.c2,title:"Software de docking",items:["AutoDock Vina 1.2 / Vina-GPU (gratis)","Gnina — scoring CNN, muy preciso","Glide SP/XP (Schrödinger)","GOLD — sitios flexibles","rDock — gratis, buen rendimiento"]},
              {col:C.c3,title:"Preparación del ligando",items:["Open Babel: SDF/MOL2/PDBQT","RDKit: confórmero 3D + MMFF94","AM1-BCC o RESP para cargas","Revisar estereoquímica y tautómeros","LigPrep (Schrödinger) — completo"]},
              {col:C.c4,title:"Validación",items:["Re-docking co-cristal: RMSD < 2.0 Å","PLIP — mapa de interacciones","ProLIF — huellas de interacciones","MM-GBSA/PBSA para ΔG binding","AUC-ROC con decoys"]},
            ].map(({col,title,items})=>(
              <div key={title} style={{...card,borderColor:col+"44"}}>
                <div style={{fontWeight:700,color:col,marginBottom:6,fontSize:12}}>{title}</div>
                {items.map(item=><div key={item} style={{fontSize:11,color:C.txd,padding:"3px 0",borderBottom:`1px solid ${C.bd}18`,display:"flex",gap:5}}><span style={{color:col,flexShrink:0}}>›</span>{item}</div>)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
