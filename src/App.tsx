// App.tsx — Historic Cadastre Viewer with US2 + US3 changes
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import TileWMS from 'ol/source/TileWMS'
import { register } from 'ol/proj/proj4'
import proj4 from 'proj4'
import { get as getProjection } from 'ol/proj'
import { createXYZ } from 'ol/tilegrid'
import { ScaleLine, Attribution } from 'ol/control'
import VectorSource from 'ol/source/Vector'
import VectorLayer from 'ol/layer/Vector'
import GeoJSON from 'ol/format/GeoJSON'
import Overlay from 'ol/Overlay'
import type MapBrowserEvent from 'ol/MapBrowserEvent'
import { Style, Stroke, Fill } from 'ol/style'
import { boundingExtent } from 'ol/extent'

// ===== EPSG:3301 =====
proj4.defs(
  'EPSG:3301',
  '+proj=lcc +lat_1=59.33333333333334 +lat_2=58 +lat_0=57.51755393055556 +lon_0=24 +x_0=500000 +y_0=6375000 +ellps=GRS80 +units=m +no_defs'
)
register(proj4)

const EE_FULL_EXTENT_3301: [number, number, number, number] = [-410958, 5952700, 1250450, 7092190]
const EE_NAV_EXTENT_3301: [number, number, number, number] = [300000, 6300000, 800000, 6700000]
const proj3301 = getProjection('EPSG:3301')!
proj3301.setExtent(EE_FULL_EXTENT_3301)

const tileGrid3301 = createXYZ({ extent: EE_FULL_EXTENT_3301, tileSize: 512, maxZoom: 19 })
const EE_CENTER_3301: [number, number] = [538000, 6500000]
const EE_ZOOM = 6
const STORAGE_KEY = 'mapView3301'

// ===== WMS =====
const GRAY_WMS_URL = 'https://kaart.maaamet.ee/wms/hallkaart?'
const GRAY_LAYERS = 'kaart_ht'
const GRAY_VERSION = '1.1.1'

const CAD_WMS_URL = 'https://gsavalik.envir.ee/geoserver/kataster/wms?'
const CAD_LAYERS = 'kataster:ky_versioonid'
const CAD_VERSION = '1.1.1'

// ===== WFS (US2/US3) =====
const WFS_URL = 'https://gsavalik.envir.ee/geoserver/kataster/wfs?'
const WFS_TYPENAME = 'kataster:ky_versioonid'

// Table data types
type KyFeatureProps = {
  tunnus: string
  kehtiv_alates: string | null
  kehtiv_kuni: string | null
  omviis?: string | null
  [key: string]: unknown
}
type WfsFeature = { id: string; properties: KyFeatureProps }
type WfsResponse = { type: 'FeatureCollection'; features: WfsFeature[] }

const TUNNUS_RE = /^\d{5}:\d{3}:\d{4}$/

// Map colors for two versions max
const COLORS = ['#22c55e', '#3b82f6'] // green, blue

// Detail table config
const DETAIL_HIDDEN_COLS = ['id', 'kirje_muudetud']
const DETAIL_COL_WIDTHS: Record<string, number> = {
  tunnus: 20,
  hkood: 4, 
  mk_nimi: 20,
  ov_nimi: 20,
  ay_nimi: 20,
  l_aadress: 20,
  ads_oid: 12,
  kehtiv_alates: 10,
  kehtiv_kuni: 10,
  siht1: 25,
  siht2: 25,
  siht3: 25,
  so_prts1: 3,
  so_prts2: 3,
  so_prts3: 3,
  kinnistu: 20,
  omviis: 20,
  omvorm: 20,
  maks_hind: 20,
  marked: 30,
  pindala: 20
}

// Persist view
function loadSavedView() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as { center: [number, number]; zoom: number }) : null
  } catch { return null }
}
function saveView(center?: [number, number], zoom?: number) {
  if (!center || typeof zoom !== 'number') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ center, zoom }))
}

// Build WFS URL for list
function buildWfsUrl(tunnus: string, date?: string) {
  const base = new URL(WFS_URL)
  base.searchParams.set('service', 'WFS')
  base.searchParams.set('version', '1.1.0')
  base.searchParams.set('request', 'GetFeature')
  base.searchParams.set('typeName', WFS_TYPENAME)
  base.searchParams.set('outputFormat', 'application/json')
  base.searchParams.set('srsName', 'EPSG:3301')
  base.searchParams.set('propertyName', 'tunnus,kehtiv_alates,kehtiv_kuni,omviis')
  const safe = tunnus.replace(/'/g, "''")
  const cql = date
    ? `tunnus = '${safe}' AND kehtiv_alates <= '${date}' AND (kehtiv_kuni IS NULL OR kehtiv_kuni > '${date}')`
    : `tunnus = '${safe}'`
  base.searchParams.set('CQL_FILTER', cql)
  base.searchParams.set('sortBy', 'kehtiv_alates D')
  base.searchParams.set('maxFeatures', '200')
  return base.toString()
}

// Build WFS URL for full geometry
function buildWfsUrl_fullByVersion(tunnus: string, ka: string|null, kk: string|null) {
  const base = new URL(WFS_URL)
  base.searchParams.set('service', 'WFS')
  base.searchParams.set('version', '1.1.0')
  base.searchParams.set('request', 'GetFeature')
  base.searchParams.set('typeName', WFS_TYPENAME)
  base.searchParams.set('outputFormat', 'application/json')
  base.searchParams.set('srsName', 'EPSG:3301')
  const safeT = tunnus.replace(/'/g, "''")
  const safeKa = ka ? ka.replace(/'/g, "''") : ''
  const safeKk = kk ? kk.replace(/'/g, "''") : ''
  const cql = kk
    ? `tunnus = '${safeT}' AND kehtiv_alates = '${safeKa}' AND kehtiv_kuni = '${safeKk}'`
    : `tunnus = '${safeT}' AND kehtiv_alates = '${safeKa}' AND kehtiv_kuni IS NULL`
  base.searchParams.set('CQL_FILTER', cql)
  return base.toString()
}

// Build WFS URL for all properties of a tunnus
function buildWfsUrl_allProps(tunnus: string) {
  const base = new URL(WFS_URL)
  base.searchParams.set('service', 'WFS')
  base.searchParams.set('version', '1.1.0')
  base.searchParams.set('request', 'GetFeature')
  base.searchParams.set('typeName', WFS_TYPENAME)
  base.searchParams.set('outputFormat', 'application/json')
  base.searchParams.set('srsName', 'EPSG:3301')
  const safe = tunnus.replace(/'/g, "''")
  base.searchParams.set('CQL_FILTER', `tunnus = '${safe}'`)
  base.searchParams.set('sortBy', 'kehtiv_alates D')
  base.searchParams.set('maxFeatures', '200')
  return base.toString()
}

// Build WFS URL to identify unit by point
function buildWfsUrl_byPoint(x: number, y: number, date?: string) {
  const base = new URL(WFS_URL)
  base.searchParams.set('service', 'WFS')
  base.searchParams.set('version', '1.1.0')
  base.searchParams.set('request', 'GetFeature')
  base.searchParams.set('typeName', WFS_TYPENAME)
  base.searchParams.set('outputFormat', 'application/json')
  base.searchParams.set('srsName', 'EPSG:3301')
  base.searchParams.set('propertyName', 'tunnus,kehtiv_alates,kehtiv_kuni')
  const cqlParts = [`INTERSECTS(geom,SRID=3301;POINT(${x} ${y}))`]
  if (date) {
    cqlParts.push(`kehtiv_alates <= '${date}' AND (kehtiv_kuni IS NULL OR kehtiv_kuni > '${date}')`)
  }
  base.searchParams.set('CQL_FILTER', cqlParts.join(' AND '))
  base.searchParams.set('sortBy', 'kehtiv_alates D')
  base.searchParams.set('maxFeatures', '1')
  return base.toString()
}

export default function App() {
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)

  const popupRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<Overlay | null>(null)

  const grayRef = useRef<TileLayer<TileWMS> | null>(null)
  const cadRef = useRef<TileLayer<TileWMS> | null>(null)

  const vecSrcRef = useRef(new VectorSource())
  const vecLayerRef = useRef<VectorLayer<VectorSource> | null>(null)

  const [showGray, setShowGray] = useState(true)
  const [showCad, setShowCad] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false) // layers panel
  const [dateOpen, setDateOpen] = useState(false)   // as-of date panel

  const [term, setTerm] = useState('')

  const [asOf, setAsOf] = useState(() => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().slice(0, 10)
  })

  const [rows, setRows] = useState<KyFeatureProps[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isValidTunnus = useMemo(() => TUNNUS_RE.test(term), [term])

  const [popupData, setPopupData] = useState<{ tunnus: string } | null>(null)

  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [colorByKey, setColorByKey] = useState<Record<string, string>>({})
  const [drawer, setDrawer] = useState<{ open: boolean; tunnus?: string; rows?: KyFeatureProps[] }>({ open: false })
  const detailCols = useMemo(
    () => drawer.rows && drawer.rows.length
      ? Object.keys(drawer.rows[0]).filter(k => !DETAIL_HIDDEN_COLS.includes(k))
      : [],
    [drawer.rows]
  )

  // Toast
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000)
      return () => clearTimeout(t)
    }
  }, [toast])

  // Assign colors
  function assignColors(keys: string[]) {
    const next: Record<string, string> = {}
    keys.forEach((k, i) => { next[k] = COLORS[i] })

    setColorByKey(next)

    // push color to each feature so the style can read it
    const feats = vecSrcRef.current.getFeatures()
    feats.forEach(f => {
      const k = f.get('___key')
      if (k && next[k]) f.set('___color', next[k])  // store color on feature
    })

    // refresh paint
    vecLayerRef.current?.changed()
  }

  const closePopup = useCallback(() => {
    overlayRef.current?.setPosition(undefined)
    setPopupData(null)
  }, [])

  function handlePopupTunnusClick(t: string) {
    setTerm(t)
    void doSearch(t)
    closePopup()
  }

  const handleMapClick = useCallback(async (evt: MapBrowserEvent<PointerEvent>) => {
    const [x, y] = evt.coordinate as [number, number]
    closePopup()
    try {
      const url = buildWfsUrl_byPoint(x, y, asOf || undefined)
      const r = await fetch(url)
      if (!r.ok) return
      const json = (await r.json()) as WfsResponse
      const feat = json.features?.[0]
      if (feat) {
        setPopupData({ tunnus: feat.properties.tunnus })
        overlayRef.current?.setPosition([x, y])
      }
    } catch {
      // ignore
    }
  }, [asOf, closePopup])

  // Map init
  useEffect(() => {
    if (!mapDivRef.current) return

    grayRef.current = new TileLayer({
      visible: true,
      source: new TileWMS({
        url: GRAY_WMS_URL,
        params: { LAYERS: GRAY_LAYERS, FORMAT: 'image/png', TRANSPARENT: false, VERSION: GRAY_VERSION, SRS: 'EPSG:3301', TILED: true },
        attributions: '© Maa- ja Ruumiamet / Estonian Land Board',
        wrapX: false,
        tileGrid: tileGrid3301,
      }),
    })

    cadRef.current = new TileLayer({
      visible: true,
      opacity: 0.9,
      source: new TileWMS({
        url: CAD_WMS_URL,
        params: { LAYERS: CAD_LAYERS, FORMAT: 'image/png', TRANSPARENT: true, VERSION: CAD_VERSION, SRS: 'EPSG:3301', TILED: true },
        wrapX: false,
        tileGrid: tileGrid3301,
      }),
    })

    vecLayerRef.current = new VectorLayer({
      source: vecSrcRef.current,
      style: (feat) => {
        const col = feat.get('___color') || '#22c55e'   // <- read from feature
        return new Style({
          stroke: new Stroke({ color: col, width: 2 }),
          fill: new Fill({ color: `${col}33` }),
        })
      },
    })


    const saved = loadSavedView()
    const view = new View({
      projection: proj3301,
      center: saved?.center || EE_CENTER_3301,
      zoom: saved?.zoom ?? EE_ZOOM,
      extent: EE_NAV_EXTENT_3301,
    })

    const map = new Map({
      target: mapDivRef.current,
      layers: [grayRef.current, cadRef.current, vecLayerRef.current],
      view,
      controls: [
        new ScaleLine({ className: 'custom-scale' }),
        new Attribution({ collapsible: false, className: 'custom-attribution ol-attribution--no-button' }),
      ],
    })
    if (popupRef.current) {
      overlayRef.current = new Overlay({
        element: popupRef.current,
        positioning: 'bottom-center',
        offset: [0, -10],
        stopEvent: true,
      })
      map.addOverlay(overlayRef.current)
    }
    mapRef.current = map
    map.on('moveend', () => saveView(view.getCenter() as [number, number], view.getZoom()))
    return () => map.setTarget(undefined)
  }, [])

  useEffect(() => { if (grayRef.current) grayRef.current.setVisible(showGray) }, [showGray])
  useEffect(() => { if (cadRef.current) cadRef.current.setVisible(showCad) }, [showCad])
  useEffect(() => {
    const src = cadRef.current?.getSource()
    if (src) {
      const filter = asOf
        ? `kehtiv_alates <= '${asOf}' AND (kehtiv_kuni IS NULL OR kehtiv_kuni > '${asOf}')`
        : undefined
      src.updateParams({ CQL_FILTER: filter })
    }
  }, [asOf])

  useEffect(() => {
    vecLayerRef.current?.changed()
  }, [colorByKey])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.on('singleclick', handleMapClick as unknown as (e: MapBrowserEvent<UIEvent>) => void)
    map.on('pointerdrag', closePopup as unknown as (e: MapBrowserEvent<UIEvent>) => void)
    return () => {
      map.un('singleclick', handleMapClick as unknown as (e: MapBrowserEvent<UIEvent>) => void)
      map.un('pointerdrag', closePopup as unknown as (e: MapBrowserEvent<UIEvent>) => void)
    }
  }, [handleMapClick, closePopup])


  // Search
  const doSearch = useCallback(async (tunnusOverride?: string) => {
    const q = (tunnusOverride ?? term).trim()
    const valid = TUNNUS_RE.test(q)
    setError(null); setRows([])
    if (!valid) { setError('Palun sisesta täielik tunnus kujul 79501:027:0011'); return }
    setLoading(true)
    try {
      const url = buildWfsUrl(q, asOf || undefined)
      const r = await fetch(url)
      if (!r.ok) throw new Error(`WFS error ${r.status}`)
      const json = (await r.json()) as WfsResponse
      const items: KyFeatureProps[] = (json.features || []).map(f => f.properties as KyFeatureProps)
      // Sort
      items.sort((a, b) => {
        const aActive = a.kehtiv_kuni === null
        const bActive = b.kehtiv_kuni === null
        if (aActive && !bActive) return -1
        if (!aActive && bActive) return 1
        if (a.kehtiv_kuni && b.kehtiv_kuni) {
          const diff = new Date(b.kehtiv_kuni).getTime() - new Date(a.kehtiv_kuni).getTime()
          if (diff !== 0) return diff
        }
        if (a.kehtiv_alates && b.kehtiv_alates) {
          return new Date(b.kehtiv_alates).getTime() - new Date(a.kehtiv_alates).getTime()
        }
        return 0
      })
      setRows(items)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Päring ebaõnnestus')
    } finally {
      setLoading(false)
    }
  }, [asOf, term])

  // Toggle version on map
  async function toggleVersion(row: KyFeatureProps) {
    const k = `${row.tunnus}|${row.kehtiv_alates}|${row.kehtiv_kuni}`
    const already = selectedKeys.includes(k)

    if (already) {
      const newKeys = selectedKeys.filter(x => x !== k)
      setSelectedKeys(newKeys)
      assignColors(newKeys)
      vecSrcRef.current.getFeatures()
        .filter(f => f.get('___key') === k)
        .forEach(f => vecSrcRef.current.removeFeature(f))
      if (drawer.open && drawer.tunnus === row.tunnus && !newKeys.some(x => x.startsWith(`${row.tunnus}|`))) {
        setDrawer({ open: false })
      }
      return
    }

    if (selectedKeys.length >= 2) {
      setToast('Maksimaalselt 2 versiooni saab korraga võrrelda. Eemalda üks, et lisada uus.')
      return
    }

    try {
      const url = buildWfsUrl_fullByVersion(row.tunnus, row.kehtiv_alates, row.kehtiv_kuni)
      const r = await fetch(url)
      if (!r.ok) throw new Error(`WFS error ${r.status}`)
      const gj = await r.json()
      const feats = new GeoJSON().readFeatures(gj, { dataProjection: 'EPSG:3301', featureProjection: 'EPSG:3301' })
      if (!feats.length) throw new Error('Geomeetriat ei leitud.')
      const newKeys = [...selectedKeys, k]
      setSelectedKeys(newKeys)
      assignColors(newKeys)
      feats.forEach(f => f.set('___key', k))
      vecSrcRef.current.addFeatures(feats)

      const detUrl = buildWfsUrl_allProps(row.tunnus)
      const detRes = await fetch(detUrl)
      if (!detRes.ok) throw new Error(`WFS error ${detRes.status}`)
      const detJson = (await detRes.json()) as WfsResponse
      const detRows = (detJson.features || []).map(f => f.properties as KyFeatureProps)
      detRows.sort((a, b) => new Date(b.kehtiv_alates ?? '').getTime() - new Date(a.kehtiv_alates ?? '').getTime())
      setDrawer({ open: true, tunnus: row.tunnus, rows: detRows })
      const exts = feats.map(f => f.getGeometry()!.getExtent())
      const union = boundingExtent(exts)
      mapRef.current?.getView().fit(union, { duration: 350, padding: [40, 40, 200, 40], maxZoom: 17 })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Versiooni laadimine ebaõnnestus')
    }
  }

  function clearSelections() {
    setSelectedKeys([])
    setColorByKey({})
    vecSrcRef.current.clear()
    setDrawer({ open: false })
  }

  // zoom handlers with animation
  const handleZoomIn  = () => { const v = mapRef.current?.getView(); if (v) v.animate({ zoom: (v.getZoom() ?? 0) + 1, duration: 250 }) }
  const handleZoomOut = () => { const v = mapRef.current?.getView(); if (v) v.animate({ zoom: (v.getZoom() ?? 0) - 1, duration: 250 }) }

  function fitAllSelected() {
    const feats = vecSrcRef.current.getFeatures()
    if (!feats.length) return
    const exts = feats.map(f => f.getGeometry()!.getExtent())
    const union = boundingExtent(exts)
    mapRef.current?.getView().fit(union, { duration: 350, padding: [40, 40, 200, 40], maxZoom: 17 })
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100">
      {/* Header */}
      <header className="backdrop-blur-md bg-gray-800/70 px-4 py-2 flex items-center gap-4 shadow-lg">
        <h1 className="font-semibold text-lg tracking-wide">Katastriüksuse versioonid</h1>
      </header>

      <div className="flex-1 p-3">
        <div className="relative h-full w-full rounded-2xl overflow-hidden shadow-xl border border-gray-700">
          {/* Map */}
          <div ref={mapDivRef} className="absolute inset-0" />
          <div ref={popupRef} className="" >
            {popupData && (
              <div className="relative pointer-events-auto bg-gray-800/90 border border-gray-600 rounded-md px-2 py-1 text-sm text-gray-100 shadow">
                <button
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-700 text-gray-300 hover:text-white"
                  onClick={closePopup}
                >
                  ✕
                </button>
                <button
                  className="underline font-mono"
                  onClick={() => handlePopupTunnusClick(popupData.tunnus)}
                >
                  {popupData.tunnus}
                </button>
              </div>
            )}
          </div>

          {/* Top-right toolbar */}
          <div className="absolute top-3 right-3 flex flex-col items-center gap-2 z-10">
            <button
              aria-label="Select date"
              onClick={() => setDateOpen(s => { const n = !s; if (n) setPanelOpen(false); return n })}
              className="p-2 rounded-lg bg-gray-800/80 hover:bg-gray-700/80 border border-gray-600 shadow"
              title="Vali kuupäev"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="4" width="18" height="17" rx="2" ry="2" stroke="currentColor" strokeWidth="1.5" />
                <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" strokeWidth="1.5" />
                <line x1="8" y1="4" x2="8" y2="2" stroke="currentColor" strokeWidth="1.5" />
                <line x1="16" y1="4" x2="16" y2="2" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              aria-label="Layers"
              onClick={() => setPanelOpen(s => { const n = !s; if (n) setDateOpen(false); return n })}
              className="p-2 rounded-lg bg-gray-800/80 hover:bg-gray-700/80 border border-gray-600 shadow"
              title="Layers"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M12 3l9 5-9 5-9-5 9-5z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M21 12l-9 5-9-5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M21 16l-9 5-9-5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button aria-label="Zoom in"  onClick={handleZoomIn}  className="p-2 rounded-lg bg-gray-800/80 hover:bg-gray-700/80 border border-gray-600 shadow" title="Zoom in">+</button>
            <button aria-label="Zoom out" onClick={handleZoomOut} className="p-2 rounded-lg bg-gray-800/80 hover:bg-gray-700/80 border border-gray-600 shadow" title="Zoom out">−</button>
          </div>

          {/* Date panel */}
          {dateOpen && (
            <div className="absolute top-3 right-14 w-64 rounded-xl bg-gray-800/80 text-gray-100 border border-gray-600 shadow-lg backdrop-blur-md p-3 z-10">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Kehtiv kuupäev</div>
                <button aria-label="Close date" className="text-gray-300 hover:text-white" onClick={() => setDateOpen(false)}>✕</button>
              </div>
              <div className="space-y-2 text-sm">
                <input
                  type="date"
                  value={asOf}
                  onChange={(e) => { setAsOf(e.target.value); if (term && isValidTunnus) void doSearch() }}
                  className="w-full rounded-lg bg-gray-900/70 border border-gray-700 px-3 py-2 outline-none focus:ring-2 focus:ring-sky-500"
                />
                <button
                  onClick={() => { setAsOf(''); if (term && isValidTunnus) void doSearch() }}
                  className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 border border-gray-600"
                >
                  Puhasta kuupäev
                </button>
              </div>
            </div>
          )}

          {/* Layers panel (with Fit & Clear) */}
          {panelOpen && (
            <div className="absolute top-3 right-14 w-72 rounded-xl bg-gray-800/80 text-gray-100 border border-gray-600 shadow-lg backdrop-blur-md p-3 z-10">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Kihid</div>
                <button aria-label="Close layers" className="text-gray-300 hover:text-white" onClick={() => setPanelOpen(false)}>✕</button>
              </div>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-emerald-500" checked={showGray} onChange={e => setShowGray(e.target.checked)} />
                  <span>Hallkaart</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 accent-sky-500" checked={showCad} onChange={e => setShowCad(e.target.checked)} />
                  <span>Katastri piirid (WMS)</span>
                </label>

                <div className="pt-2 border-t border-gray-700 mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={fitAllSelected}
                    className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 border border-gray-600"
                  >
                    Suurenda valitud
                  </button>
                  <button
                    onClick={clearSelections}
                    className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 border border-gray-600"
                  >
                    Puhasta valik
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* US2: Search by tunnus (submit to query) */}
          <form
            className="absolute top-3 left-3 w-[30rem] max-w-[92vw] rounded-xl bg-gray-800/80 text-gray-100 border border-gray-600 shadow-lg backdrop-blur-md p-3 z-10"
            onSubmit={(e) => { e.preventDefault(); void doSearch() }}
          >
            <label className="block text-sm mb-2 font-medium">Otsi tunnusega</label>
            <div className="flex gap-2">
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value.trim())}
                placeholder="nt 79501:027:0011"
                className="flex-1 rounded-lg bg-gray-900/70 border border-gray-700 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
                aria-invalid={!isValidTunnus && term.length > 0}
              />
              <button
                type="submit"
                disabled={!isValidTunnus || loading}
                className={`px-3 py-2 rounded-lg text-sm font-medium border ${
                  isValidTunnus && !loading
                    ? 'bg-sky-600 hover:bg-sky-500 border-sky-500'
                    : 'bg-gray-700 border-gray-600 text-gray-300 cursor-not-allowed'
                }`}
              >
                {loading ? 'Otsin…' : 'Otsi'}
              </button>
            </div>

            <div className="mt-2 text-xs">
              {!term
                ? <span className="text-gray-300">Sisesta täielik tunnus (näide: 79501:027:0011) ja vajuta Enter.</span>
                : !isValidTunnus
                  ? <span className="text-amber-300">Vale vorming. Vaja on 5+3+4 numbrit: 00000:000:0000</span>
                  : error
                    ? <span className="text-red-300">Viga: {error}</span>
                    : rows.length > 0
                      ? <span className="text-gray-300">{rows.length} versiooni</span>
                      : !loading && <span className="text-gray-300">Tulemusi ei leitud.</span>}
            </div>

            {/* Results table */}
            <div className="mt-3 max-h-72 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-700">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-gray-900/60 sticky top-0">
                  <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-semibold text-gray-200">
                    <th className="w-[11rem]">Tunnus</th>
                    <th className="w-[8.5rem]">Kehtiv alates</th>
                    <th className="w-[8.5rem]">Kehtiv kuni</th>
                    <th>Omastamise viis</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {rows.map((r, i) => {
                    const k = `${r.tunnus}|${r.kehtiv_alates}|${r.kehtiv_kuni}`
                    const selected = selectedKeys.includes(k)
                    const color = selected ? colorByKey[k] : '#4b5563'
                    return (
                      <tr
                        key={`${r.tunnus}-${r.kehtiv_alates}-${i}`}
                        className={`cursor-pointer ${selected ? 'bg-gray-900/60' : 'hover:bg-gray-900/40'}`}
                        onClick={() => void toggleVersion(r)}
                        title={selected ? 'Eemalda valikust' : 'Lisa valikusse'}
                      >
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: color }} />
                          {r.tunnus}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.kehtiv_alates)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {fmtDate(r.kehtiv_kuni) || <span className="text-emerald-300 font-medium">aktiivne</span>}
                        </td>
                        <td className="px-3 py-2 truncate" title={r.omviis || ''}>{r.omviis || ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-2 text-xs text-gray-400">
              Klõpsa real: lisab/eemaldab versiooni, joonistab kaardile ja avab allservas info kasti.
            </div>
          </form>

          {/* Legend for selected versions (bottom-left above scale) */}
          {selectedKeys.length > 0 && (
            <div className="absolute bottom-16 left-3 bg-gray-800/80 border border-gray-700 rounded-lg shadow p-2 text-xs z-10">
              <div className="font-medium mb-1">Valitud versioonid</div>
              <div className="space-y-1 max-h-40 overflow-auto pr-1">
                {selectedKeys.map(k => {
                  const [t, ka, kk] = k.split('|')
                  const col = colorByKey[k]
                  return (
                    <div key={k} className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-sm" style={{ background: col }} />
                      <span className="font-mono">{t}</span>
                      <span className="text-gray-300">[{fmtDate(ka)} → {kk === 'null' ? 'aktiivne' : fmtDate(kk)}]</span>
                    </div>
                  )
                })}
              </div>
              <div className="mt-2">
                <button
                  onClick={clearSelections}
                  className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 border border-gray-600"
                >
                  Puhasta
                </button>
              </div>
            </div>
          )}

          {/* Bottom info drawer (wide, horizontal scroll, chevron toggle) */}
          <div className="absolute left-0 right-0 bottom-0 z-20 pointer-events-none">
            {/* Handle */}
            <div className="mx-auto w-fit pointer-events-auto">
              <button
                onClick={() => setDrawer(d => ({ ...d, open: !d.open }))}
                className="mx-auto mb-2 flex items-center gap-2 rounded-full bg-gray-800/95 border border-gray-700 px-3 py-1 text-xs text-gray-100 shadow"
                title={drawer.open ? 'Peida detailid' : 'Ava detailid'}
              >
                {drawer.open ? 'Peida detailid' : 'Versiooni detailid'}
                <span className="text-lg leading-none">{drawer.open ? '▾' : '▴'}</span>
              </button>
            </div>

            {/* Panel */}
            {drawer.open && drawer.rows && (
              <div className="mx-auto max-w-[95vw] bg-gray-800/95 text-gray-100 border-t border-gray-700 shadow-[0_-8px_30px_rgba(0,0,0,0.5)] rounded-t-2xl p-4 pointer-events-auto">
                <div className="text-sm font-medium mb-3">Versiooni detailid</div>
                <div className="overflow-x-auto">
                  <table className="text-sm" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr className="text-gray-300">
                        {detailCols.map(k => (
                          <th
                            key={k}
                            style={{ width: `${DETAIL_COL_WIDTHS[k] ?? 140}px` }}
                            className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-700"
                          >
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {drawer.rows.map((r, i) => (
                        <tr key={i} className="odd:bg-gray-900/40">
                          {detailCols.map(k => (
                            <td
                              key={k}
                              style={{ width: `${DETAIL_COL_WIDTHS[k] ?? 140}px` }}
                              className="px-3 py-2 border-b border-gray-700 whitespace-nowrap"
                            >
                              {String(r[k] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Toast (top-right) */}
          {toast && (
            <div className="absolute top-3 right-3 z-20">
              <div className="rounded-lg bg-gray-800/95 border border-gray-700 shadow px-3 py-2 text-sm text-gray-100">
                {toast}
              </div>
            </div>
          )}

          {/* Bottom-left/right controls are styled via index.css (custom-scale / custom-attribution) */}
        </div>
      </div>
    </div>
  )
}

// === helpers at file bottom ===
function fmtDate(s?: string | null) {
  if (!s) return ''
  return s.length > 10 ? s.slice(0, 10) : s
}

