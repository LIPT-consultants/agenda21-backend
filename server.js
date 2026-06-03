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

app.post("/api/enrichir", async (req, res) => {
  try {
    const { citycode, city, lat, lon } = req.body;
    const results = {};
    const geoCode = "2025-COM-" + citycode;

    function set(id, val, source, niveau) {
      if (val !== null && val !== undefined && !isNaN(parseFloat(val))) {
        results[id] = { valeur: String(Math.round(parseFloat(val) * 10) / 10), source, niveau };
      }
    }

    // 1. API Geo
    try {
      const r1 = await defaultAxios.get("https://geo.api.gouv.fr/communes/" + citycode + "?fields=nom,population,codeDepartement,codeRegion,epci");
      const d = r1.data;
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
        const r2 = await defaultAxios.get("https://georisques.gouv.fr/api/v1/gaspar/risques?rayon=1000&latlon=" + lon + "," + lat + "&page=1&page_size=20");
        console.log("Georisques:", r2.status);
        const d = r2.data;
        if (d && d.data && d.data.length > 0) {
          const risques = d.data.map((x) => x.libelle_risque_jo || x.code_risque).filter(Boolean);
          results["_meta_georisques"] = { valeur: "Risques : " + risques.slice(0, 5).join(", "), source: "Georisques 2026", niveau: "adresse" };
          if (risques.some((x) => x.toLowerCase().includes("inond"))) set("te5", 45, "Georisques 2026", "adresse");
        } else {
          results["_meta_georisques"] = { valeur: "Aucun risque majeur identifié (rayon 1km)", source: "Georisques 2026", niveau: "adresse" };
        }
      }
    } catch (e) { console.log("Georisques error:", e.message); }

    // 3. ADEME DPE
    try {
      const cityEncoded = encodeURIComponent(city || "");
      const r3 = await defaultAxios.get("https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=500&select=etiquette_dpe&q=" + cityEncoded);
      console.log("ADEME DPE:", r3.status, "résultats:", r3.data?.results?.length);
      const d = r3.data;
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

    // 4. INSEE RP — population par âge
    try {
      const r4 = await inseeAxios.get(
        "https://api.insee.fr/melodi/data/DS_RP_POPULATION_PRINC?GEO=" + geoCode + "&TIME_PERIOD=2022&maxResult=500&page=1"
      );
      console.log("INSEE RP:", r4.status, "obs:", r4.data?.observations?.length);
      const obs4 = r4.data?.observations || [];
      let total = 0, s60 = 0, s75 = 0;
      obs4.forEach((o) => {
        const v = parseFloat(o.measures?.OBS_VALUE_NIVEAU?.value || 0);
        const age = o.dimensions?.AGE || "";
        const sex = o.dimensions?.SEX || "";
        if (sex !== "_T") return;
        if (isNaN(v) || v <= 0) return;
        if (age === "_T") total += v;
        if (["Y_GE65", "Y_GE80"].includes(age)) s60 += v;
        if (age === "Y_GE80") s75 += v;
      });
      if (total > 0) {
        set("v1", s60 / total * 100, "INSEE RP 2022", "commune");
        set("v2", s75 / total * 100, "INSEE RP 2022", "commune");
        results["_meta_rp"] = { valeur: Math.round(total) + " hab. recensés", source: "INSEE RP 2022", niveau: "commune" };
      }
    } catch (e) { console.log("INSEE RP error:", e.response?.status, e.message); }

    // 5. BPE — équipements santé
    try {
      const r5 = await inseeAxios.get(
        "https://api.insee.fr/melodi/data/DS_BPE?GEO=" + geoCode + "&TIME_PERIOD=2024&maxResult=200&page=1"
      );
      console.log("BPE:", r5.status, "obs:", r5.data?.observations?.length);
      const obs5 = r5.data?.observations || [];
      let medecins = 0, pharmacies = 0, ehpad = 0;
      obs5.forEach((o) => {
        const v = parseFloat(o.measures?.OBS_VALUE_NIVEAU?.value || 0);
        const type = o.dimensions?.FACILITY_TYPE || "";
        if (isNaN(v) || v <= 0) return;
        if (type === "D201") medecins += v;
        if (type === "D401") pharmacies += v;
        if (type === "D109" || type === "D110") ehpad += v;
      });
      const partenaires = (medecins > 0 ? 1 : 0) + (ehpad > 0 ? 2 : 0) + (pharmacies > 0 ? 1 : 0);
      if (partenaires > 0) set("pt1", partenaires, "INSEE BPE 2024", "commune");
      if (medecins > 0 || pharmacies > 0 || ehpad > 0) {
        results["_meta_bpe"] = { valeur: Math.round(medecins) + " médecins, " + Math.round(pharmacies) + " pharmacies, " + Math.round(ehpad) + " EHPAD", source: "INSEE BPE 2024", niveau: "commune" };
      }
    } catch (e) { console.log("BPE error:", e.response?.status, e.message); }

    // 6. RP Ménages — debug TPH et PREFPH
    try {
      const r6 = await inseeAxios.get(
        "https://api.insee.fr/melodi/data/DS_RP_MENAGES_COMP?GEO=" + geoCode + "&TIME_PERIOD=2022&maxResult=200&page=1"
      );
      console.log("RP Ménages:", r6.status, "obs:", r6.data?.observations?.length);
      const obs6 = r6.data?.observations || [];
      const tphSeen = [...new Set(obs6.map((o) => o.dimensions?.TPH))];
      const prefphSeen = [...new Set(obs6.map((o) => o.dimensions?.PREFPH))];
      console.log("TPH disponibles:", JSON.stringify(tphSeen));
      console.log("PREFPH disponibles:", JSON.stringify(prefphSeen));
      const obs6sample = obs6.filter(o => o.dimensions?.TPH === "11").slice(0, 5);
console.log("Ménages seuls sample:", JSON.stringify(obs6sample));
    } catch (e) { console.log("RP Ménages error:", e.response?.status, e.message); }

    console.log("Résultats finaux:", Object.keys(results));
    res.json(results);
  } catch (err) {
    console.log("Erreur globale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Agenda21 Backend démarré sur le port ${PORT}`));
