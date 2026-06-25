# PDB Drug Discovery Workstation

Herramienta web para búsqueda de estructuras en el RCSB PDB, análisis de druggability y preparación de archivos para docking molecular.

Desarrollada en ESM-IPN.

---

## Funcionalidades

| Módulo | Descripción |
|--------|-------------|
| **Búsqueda PDB** | Por nombre/función o por UniProt ID (ej: Q9BYF1). Filtros por resolución, técnica, ligando y organismo. |
| **Visor 3D** | Panel lateral con NGL Viewer. Representación cartoon + ligando ball-and-stick. |
| **Druggability** | Links a DoGSiteScorer, FPocketWeb y CASTp. Tabla comparativa con score global ponderado. |
| **Descarga** | Proteína limpia (solo ATOM), ligando co-cristal, centroide + `config_vina.txt` listo para AutoDock Vina. |
| **Interacciones** | Tabla de contactos residuo–ligando < 4 Å + diagrama SVG descargable. |
| **ZIP completo** | Paquete con todos los archivos + CSV de druggability + instrucciones de docking. |
| **Asesoría IA** | Análisis experto de preparación y docking (requiere API key de Anthropic). |

---

## Instalación local

```bash
git clone https://github.com/tu-usuario/pdb-workstation.git
cd pdb-workstation
npm install
npm run dev
```

Abre `http://localhost:5173` en el navegador.

## Build para producción

```bash
npm run build
# Genera la carpeta dist/ lista para desplegar
```

---

## Despliegue

### Netlify (recomendado)
1. Conecta este repositorio en [netlify.com](https://netlify.com)
2. Build command: `npm run build`
3. Publish directory: `dist`
4. El archivo `netlify.toml` ya configura todo automáticamente.

### GitHub Pages
```bash
npm run build
# Sube la carpeta dist/ a la rama gh-pages
```

### Servidor institucional (Apache/Nginx)
```bash
npm run build
# Copia el contenido de dist/ al directorio web del servidor
```

---

## APIs utilizadas

- **RCSB PDB Search API v2** — búsqueda de estructuras
- **RCSB PDB REST API** — metadatos de entradas
- **UniProt REST API** — información de proteínas por acceso UniProt
- **NGL Viewer** (CDN) — visualización 3D
- **JSZip** (CDN) — exportación ZIP
- **Anthropic API** (opcional) — asesoría IA de docking

---

## Notas de uso

- La pestaña **Asesoría IA** requiere una API key propia de [console.anthropic.com](https://console.anthropic.com/keys). La clave se usa solo localmente en el navegador del usuario.
- Los archivos descargados (proteína, ligando) requieren preparación adicional antes del docking: agregar hidrógenos y cargas con AutoDockTools o PDB2PQR.
- Para validación de poses de docking, se recomienda usar PLIP o ProLIF.
