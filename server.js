const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const inseeAxios = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
  timeout: 20000,
});

const defaultAxios = axios.create({
  headers: { "User-Agent": "Mozilla/5.0" },
  timeout: 20000,
});

app.get("/", (req, res) => res.json({ status: "ok", app: "Agenda21 Longévité Backend" }));

// ─── ROUTE ANALYSE ─────────────────────────────────────────────────────────────
app.post("/api/analyse", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt manquant" });
    const response = await defaultAxios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    });
    const text = (response.data.content || []).map((b) => b.text || "").join("\n");
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─── ROUTE ENRICHIR ────────────────────────────────────────────────────────────
app.post("/api/enrichir", async (req, res) => {
  try {
    const { citycode, city, lat, lon } = req.body;
    const results = {};
    const dept = citycode ? citycode.substring(0, 2) : null;

    function set(id, val, source, niveau) {
      if (val !== null && val !== undefined && !isNaN(parseFloat(val))) {
        results[id] = { valeur: String(Math.round(parseFloat(val) * 10) / 10), source, niveau };
      }
    }

    // 1. API Geo
    try {
      const r = await defaultAxios.get("https://geo.api.gouv.fr/communes/" + citycode + "?fields=nom,population,codeDepartement,codeRegion,epci");
      const d = r.data;
      if (d.population) {
        results["_meta_population"] = { valeur: String(d.population), source: "API Geo gouv.fr", niveau: "commune" };
        results["_meta_seniors"] = { valeur: "Pop. " + d.population + " hab. (75+ estimés ~" + Math.round(d.population * 0.085) + ")", source: "API Geo + benchmark INSEE 2023", niveau: "commune" };
      }
      if (d.epci) results["_meta_epci"] = { valeur: typeof d.epci === "object" ? (d.epci.nom || d.epci.code) : String(d.epci), source: "API Geo gouv.fr", niveau: "epci" };
      if (d.codeDepartement) results["_meta_dept"] = { valeur: "Dép. " + d.codeDepartement, source: "API Geo gouv.fr", niveau: "departement" };
    } catch (e) { console.log("Geo error:", e.message); }

    // 2. Georisques
    try {
      if (lat && lon) {
        const r = await defaultAxios.get("https://georisques.gouv.fr/api/v1/gaspar/risques?rayon=1000&latlon=" + lon + "," + lat + "&page=1&page_size=20");
        console.log("Georisques:", r.status);
        const d = r.data;
        if (d && d.data && d.data.length > 0) {
          const risques = d.data.map((x) => x.libelle_risque_jo || x.code_risque).filter(Boolean);
          results["_meta_georisques"] = { valeur: "Risques : " + risques.slice(0, 5).join(", "), source: "Georisques 2026", niveau: "adresse" };
          if (risques.some((x) => x.toLowerCase().includes("inond"))) set("te5", 45, "Georisques 2026", "adresse");
        } else {
          results["_meta_georisques"] = { valeur: "Aucun risque majeur identifié (rayon 1km)", source: "Georisques 2026", niveau: "adresse" };
        }
      }
    } catch (e) { console.log("Georisques error:", e.message); }

    // 3. ADEME DPE — recherche par nom de ville (q=city) dans dpe03existant
    try {
      const cityEncoded = encodeURIComponent(city || "");
      const urlDpe = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=500&select=etiquette_dpe&q=" + cityEncoded;
      const r = await defaultAxios.get(urlDpe);
      console.log("ADEME DPE:", r.status, "résultats:", r.data?.results?.length);
      const d = r.data;
      if (d.results && d.results.length > 0) {
        let total = d.results.length, efg = 0, renove = 0;
        d.results.forEach((x) => {
          if (["E", "F", "G"].includes(x.etiquette_dpe)) efg++;
          if (["A", "B", "C"].includes(x.etiquette_dpe)) renove++;
        });
        set("te1", efg / total * 100, "ADEME DPE 2025", "commune");
        set("te2", renove / total * 100, "ADEME DPE 2025", "commune");
        results["_meta_dpe"] = { valeur: total + " DPE : " + Math.round(efg / total * 100) + "% EFG, " + Math.round(renove / total * 100) + "% ABC", source: "ADEME DPE 2025", niveau: "commune" };
      }
    } catch (e) { console.log("ADEME error:", e.response?.status, e.message); }

    // 4. RPLS via API INSEE Melodi — nb logements sociaux par commune
    try {
      const urlRpls = "https://api.insee.fr/melodi/data/DS_RPLS_LOGEMENT?GEO=COM-" + citycode + "&TIME_PERIOD=2023&INDICATEUR=NB_LOG&maxResult=5";
      const r = await inseeAxios.get(urlRpls);
      console.log("RPLS Melodi:", r.status);
      const obs = r.data?.dataSets?.[0]?.observations;
      if (obs) {
        const vals = Object.values(obs);
        if (vals.length > 0 && vals[0][0] !== null) {
          const total = vals.reduce((a, v) => a + (v[0] || 0), 0);
          if (total > 0) results["_meta_rpls"] = { valeur: Math.round(total) + " logements sociaux", source: "RPLS INSEE 2023", niveau: "commune" };
        }
      }
    } catch (e) { console.log("RPLS Melodi error:", e.response?.status, e.message); }

    // 5. BPE — via API Melodi INSEE
    try {
      const urlBpe = "https://api.insee.fr/melodi/data/DS_BPE_ENS?GEO=COM-" + citycode + "&TIME_PERIOD=2021&TYPEQU=D201,D401,D109,D110,D107&maxResult=50";
      const r = await inseeAxios.get(urlBpe);
      console.log("BPE Melodi:", r.status);
      const series = r.data?.dataSets?.[0]?.series;
      if (series) {
        let medecins = 0, pharmacies = 0, ehpad = 0, services = 0;
        Object.entries(series).forEach(([key, val]) => {
          const obs = Object.values(val.observations || {});
          const v = obs[0]?.[0] || 0;
          if (key.includes("D201")) medecins += v;
          if (key.includes("D401")) pharmacies += v;
          if (key.includes("D109") || key.includes("D110")) ehpad += v;
          if (key.includes("D107")) services += v;
        });
        const partenaires = (medecins > 0 ? 1 : 0) + (ehpad > 0 ? 2 : 0) + (services > 0 ? 2 : 0) + (pharmacies > 0 ? 1 : 0);
        if (partenaires > 0) set("pt1", partenaires, "INSEE BPE 2021", "commune");
        results["_meta_bpe"] = { valeur: Math.round(medecins) + " médecins, " + Math.round(pharmacies) + " pharmacies, " + Math.round(ehpad) + " EHPAD", source: "INSEE BPE 2021", niveau: "commune" };
      }
    } catch (e) { console.log("BPE Melodi error:", e.response?.status, e.message); }

    // 6. Filosofi — via API Melodi INSEE (taux pauvreté + revenu médian)
    try {
      const urlFilo = "https://api.insee.fr/melodi/data/DS_FILOSOFI?GEO=COM-" + citycode + "&TIME_PERIOD=2020&INDIC=TP60,MED&maxResult=10";
      const r = await inseeAxios.get(urlFilo);
      console.log("Filosofi Melodi:", r.status);
      const series = r.data?.dataSets?.[0]?.series;
      if (series) {
        Object.entries(series).forEach(([key, val]) => {
          const obs = Object.values(val.observations || {});
          const v = parseFloat(obs[0]?.[0]);
          if (isNaN(v)) return;
          if (key.includes("TP60") && v > 0) {
            set("v14", v / 100 * 0.35, "INSEE Filosofi 2020", "commune");
            results["_meta_pauvrete"] = { valeur: "Taux pauvreté : " + v + "%", source: "INSEE Filosofi 2020", niveau: "commune" };
          }
          if (key.includes("MED") && v > 0) {
            results["_meta_revenu"] = { valeur: Math.round(v) + " €/an (revenu médian)", source: "INSEE Filosofi 2020", niveau: "commune" };
          }
        });
      }
    } catch (e) { console.log("Filosofi Melodi error:", e.response?.status, e.message); }

    // 7. Recensement population par âge — via API Melodi INSEE
    try {
      const urlRp = "https://api.insee.fr/melodi/data/DS_RP_POP?GEO=COM-" + citycode + "&TIME_PERIOD=2020&AGEPYR5=Y60T64,Y65T69,Y70T74,Y75T79,Y80T84,Y85T89,Y90&maxResult=100";
      const r = await inseeAxios.get(urlRp);
      console.log("INSEE RP Melodi:", r.status);
      const dsSeries = r.data?.dataSets?.[0]?.series;
      if (dsSeries) {
        let total = 0, s60 = 0, s75 = 0, s85 = 0;
        // On récupère la population totale depuis Geo
        const popMeta = results["_meta_population"];
        if (popMeta) total = parseFloat(popMeta.valeur) || 0;
        Object.entries(dsSeries).forEach(([key, val]) => {
          const obs = Object.values(val.observations || {});
          const v = parseFloat(obs[0]?.[0] || 0);
          s60 += v;
          if (key.includes("Y75") || key.includes("Y80") || key.includes("Y85") || key.includes("Y90")) s75 += v;
          if (key.includes("Y85") || key.includes("Y90")) s85 += v;
        });
        if (total > 0) {
          set("v1", s60 / total * 100, "INSEE RP 2020", "commune");
          set("v2", s75 / total * 100, "INSEE RP 2020", "commune");
          set("v3", s85 / total * 100, "INSEE RP 2020", "commune");
        }
      }
    } catch (e) { console.log("INSEE RP Melodi error:", e.response?.status, e.message); }

    console.log("Résultats finaux:", Object.keys(results));
    res.json(results);
  } catch (err) {
    console.log("Erreur globale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Agenda21 Backend démarré sur le port ${PORT}`));
