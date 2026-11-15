import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BookOpen, ChevronRight, ExternalLink, Maximize2, X } from 'lucide-react'
import ThemeSwitch from './components/ThemeSwitch'
import { useTheme } from './theme'

/* Public front page. Static: it makes no /api requests and starts no archive downloads.
   Every image is either a real SPHEREx frame rendered by SPHERE TRACK from cached IRSA data (provenance shown with it)
   or a screenshot of the running app showing real data. */

// shortcut: repository is the configured `origin` remote; confirm before submission (see docs/SUBMISSION_CHECKLIST.md).
const REPO = 'https://github.com/tnaverttrpg-ux/Nasa-Space-App-SphereX'
const DOCS = `${REPO}/tree/main/docs`
const EXPLORER = '/explorer'
const BARNARD = '/explorer?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12'

// Provenance of the three real frames in /public/media (FITS header values, recorded when the images were exported).
const FIELD = 'Barnard’s Star field, centre RA 269.44629°, Dec +4.76792° (ICRS) · 0.5° × 0.5° · 6.15″/px · north up, east left'
const RENDER = 'SPHEREx DR1 (NASA/IPAC IRSA), detector D6, rendered by SPHERE TRACK: asinh stretch, per-frame display scaling. Grey pixels are masked by the FITS quality flags.'
const FRAMES = {
  hero: { src: '/media/barnard-d6-2025-08-15.png', obs: '2025W33_2C_0321_1', date: '2025-08-15 20:46 UTC', lam: '4.923' },
  control: { src: '/media/barnard-d6-2026-03-22.png', obs: '2026W12_2A_0520_4', date: '2026-03-22 08:51 UTC', lam: '4.930' },
  trail: { src: '/media/barnard-d6-2026-05-05-trail.png', obs: '2026W19_1A_0403_1', date: '2026-05-05 02:00 UTC', lam: '4.894' },
}

const STEPS = [
  ['Explore', 'Pick a star from the list or enter sky coordinates. SPHERE TRACK finds every SPHEREx image of that spot in NASA’s public archive and lines them up in date order.'],
  ['Compare', 'Play the observations like a flip-book, place two dates side by side, flick between them, or subtract one from the other to highlight what changed.'],
  ['Investigate', 'Click any pixel to trace it back to the original data: its sky position, the original detector pixel, quality flags and how the field was covered.'],
] as const

const FEATURES = [
  ['viewer', 'Time-series viewer', 'Every observation of one position, aligned on a shared north-up grid and played in time order on a real-time timeline.',
    'SPHERE TRACK Explorer in Sequence mode: a SPHEREx D6 frame of Barnard’s Star from 2025-08-15, with playback controls, a timeline of 12 observations, the target list and FITS header metadata.'],
  ['difference', 'Blink and difference imaging', 'Compare any two dates. The difference view marks what got brighter or fainter and lists candidate residuals with their significance.',
    'Difference view of Barnard’s Star, 2025-08-15 (A) minus 2026-05-05 (B): red and blue residuals, numbered candidate boxes, a masked diagonal trail, the two source frames and a wavelength-mismatch warning.'],
  ['pixel', 'Pixel Inspector', 'Trace one pixel from the aligned image to its sky coordinates, the original FITS pixel and its quality flags, and the detector position.',
    'Pixel Inspector on Barnard’s Star’s saturated core: the aligned-grid pixel is masked, while the original FITS pixel shows its value, the OVERFLOW, SOURCE and BLOOM flags, and its detector position.'],
  ['dashboard', 'Observation dashboard', 'Data quality, field coverage and timing for every loaded observation, with each value taken from the files themselves.',
    'Observation dashboard for 12 of 41 Barnard’s Star D6 observations: a timeline of dates and wavelengths, field coverage per observation (mean 95.8%) and pipeline data-quality counts.'],
  ['skymap', 'Sky coverage map', 'The archive footprint of every observation around the target. Click anywhere to list exactly which observations cover that point.',
    'Sky coverage map with 41 overlapping whole-detector footprints around Barnard’s Star, shaded by overlap count, a minimap, and a list of the footprints containing the inspected point.'],
  ['qa', 'Pipeline QA and quality flags', 'The SPHEREx pipeline’s own quality results, shown as recorded and kept apart from the per-pixel flags inside the field.',
    'Pipeline QA for the 2026-05-05 frame: L1 and L2 Pass, 1 satellite streak and 3,616 streak pixels reported for the whole detector, 0 streak-flagged pixels in the displayed field, and the streak advisory.'],
] as const

const CREDIBILITY = [
  ['Real archive data', 'Observations come from SPHEREx Data Release 1 at the NASA/IPAC Infrared Science Archive (IRSA), retrieved as small cutouts on request.'],
  ['FITS-based processing', 'Times, wavelengths, quality flags and coordinates are read from the original FITS files. Each image is aligned using its own coordinate solution.'],
  ['Gaia DR3 cross-check', 'An optional overlay places ESA Gaia DR3 stars at each observation’s date, so known moving stars can be told apart from unexpected changes.'],
  ['Quality checks', 'Masked pixels, detector edges, wavelength differences and registration offsets are shown and explained rather than hidden.'],
] as const

const LIMITS = [
  'A change between two dates is a candidate for follow-up, not a discovery. SPHERE TRACK does not claim to find Planet X.',
  'SPHEREx sees each visit at a slightly different wavelength, so brightness differences can be spectral rather than changes over time.',
  'A pipeline “Pass” does not prove an image is free of artefacts, and aligned pixel values are interpolated, not calibrated photometry.',
]

const btnPrimary = 'inline-flex h-11 items-center gap-2 rounded-sm bg-cta px-5 text-[15px] font-semibold text-cta-ink hover:brightness-110'
const btnSecondary = 'inline-flex h-11 items-center gap-2 rounded-sm border border-line-strong px-5 text-[15px] font-medium text-ink hover:bg-hover'
const wrap = 'mx-auto w-full max-w-6xl px-4 sm:px-6'
const eyebrow = 'font-mono text-[12px] uppercase tracking-[0.14em] text-accent-ink'

function Frame({ f, alt, caption, eager = false }: { f: typeof FRAMES.hero; alt: string; caption: React.ReactNode; eager?: boolean }) {
  return (
    <figure className="m-0">
      <div className="border border-line bg-black">
        <img src={f.src} alt={alt} width={293} height={293} loading={eager ? 'eager' : 'lazy'} decoding="async"
          className="pixelated block aspect-square w-full" />
      </div>
      <figcaption className="mt-2 text-[12px] leading-relaxed text-ink-3">{caption}</figcaption>
    </figure>
  )
}

export default function Home() {
  const theme = useTheme()
  // Screenshot lightbox: a native modal <dialog> (focus stays inside, Escape closes, the page behind is inert).
  const dlg = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  // A new object per open request, so reopening the same screenshot before the async "close" event still re-runs the effect.
  const [shot, setShot] = useState<{ i: number } | null>(null)
  useEffect(() => {
    const d = dlg.current
    if (d && shot && !d.open) { d.showModal(); document.documentElement.style.overflow = 'hidden' }
  }, [shot])
  useEffect(() => {
    const d = dlg.current
    if (!d) return
    // "close" is dispatched asynchronously: ignore a stale one that arrives after the dialog was already reopened
    const onClose = () => { if (d.open) return; setShot(null); document.documentElement.style.overflow = ''; opener.current?.focus() }
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])
  const open = shot ? FEATURES[shot.i] : null
  return (
    <div className="home-page min-h-dvh bg-panel text-[15px] leading-relaxed text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-raised focus:px-3 focus:py-2">Skip to content</a>

      <header className="sticky top-0 z-40 border-b border-line bg-panel/95 backdrop-blur">
        <div className={`${wrap} flex h-14 items-center gap-4`}>
          <a href="/" className="flex items-center gap-2" aria-label="SPHERE TRACK home">
            <img src="/favicon.svg" alt="" className="h-6 w-6" />
            <span className="text-[14px] font-semibold tracking-[0.12em] text-ink">SPHERE TRACK</span>
          </a>
          <nav aria-label="Page sections" className="ml-4 hidden items-center gap-5 text-[13px] text-ink-2 md:flex">
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#features" className="hover:text-ink">Features</a>
            <a href="#investigation" className="hover:text-ink">Investigation</a>
            <a href="#science" className="hover:text-ink">Science</a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ThemeSwitch pref={theme.pref} onChange={theme.choose} />
            <a href={EXPLORER} className="hidden h-8 items-center gap-1.5 rounded-sm border border-accent/70 px-3 text-[13px] font-medium text-accent-ink hover:bg-accent/10 sm:inline-flex">
              Explorer<ArrowRight size={14} aria-hidden />
            </a>
          </div>
        </div>
      </header>

      <main id="main">
        {/* hero */}
        <section aria-labelledby="hero-title" className="border-b border-line">
          <div className={`${wrap} grid items-center gap-10 py-14 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] md:py-20`}>
            <div className="fade-up">
              <p className={eyebrow}>NASA Space Apps Challenge 2026 · Planet X and SPHEREx</p>
              <h1 id="hero-title" className="mt-4 text-[clamp(2.25rem,6vw,3.75rem)] font-semibold leading-[1.05] tracking-tight text-ink">
                Explore the changing infrared sky.
              </h1>
              <p className="mt-5 max-w-xl text-[17px] text-ink-2">
                Investigate repeated observations from SPHEREx, compare the infrared sky across time, and explore astronomical
                sources using real archive data.
              </p>
              <p className="mt-3 max-w-xl text-[15px] text-ink-3">
                SPHEREx, a NASA space telescope, photographs the whole sky again and again. SPHERE TRACK collects every
                picture of one spot, lines them up and lets you see what moved or changed.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href={EXPLORER} className={btnPrimary}>Launch Explorer<ArrowRight size={17} aria-hidden /></a>
                <a href="#how" className={btnSecondary}>Discover how it works</a>
              </div>
              <p className="mt-4">
                <a href="#investigation" className="inline-flex items-center gap-1 text-[14px] text-accent-ink hover:underline">
                  See the Barnard’s Star investigation<ArrowRight size={14} aria-hidden />
                </a>
              </p>
            </div>
            <Frame f={FRAMES.hero} eager
              alt={`SPHEREx D6 infrared image of the field around Barnard’s Star, observed ${FRAMES.hero.date}`}
              caption={<>
                <span data-testid="hero-caption">
                  <span className="text-ink-2">Barnard’s Star</span> (centre) · {FRAMES.hero.date}<br />
                  {FRAMES.hero.obs} · detector D6 · λ {FRAMES.hero.lam} µm at target<br />
                  0.5° × 0.5° field · SPHEREx DR1, NASA/IPAC IRSA
                </span>
                <details className="group mt-1.5">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 text-accent-ink hover:underline [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={13} aria-hidden className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />Full provenance
                  </summary>
                  <dl data-testid="hero-provenance" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-ink-2">Observation</dt><dd className="m-0">SPHEREx Level 2 image {FRAMES.hero.obs}; DATE-AVG 2025-08-15T20:46:08 UTC (mid-exposure); pipeline version 7.0.5</dd>
                    <dt className="text-ink-2">Field centre</dt><dd className="m-0">RA 269.44629°, Dec +4.76792° (ICRS): Barnard’s Star, SIMBAD position propagated to epoch 2025.9</dd>
                    <dt className="text-ink-2">Grid</dt><dd className="m-0">293 × 293 pixels of 6.15″, north up, east left</dd>
                    <dt className="text-ink-2">Rendering</dt><dd className="m-0">asinh stretch, inferno colour map, scaled for this frame only (display, not photometry); grey pixels are masked by the FITS quality flags</dd>
                    <dt className="text-ink-2">Source</dt><dd className="m-0">cutout from the NASA/IPAC Infrared Science Archive (IRSA), aligned and rendered by SPHERE TRACK; this image is the app’s own output, unedited</dd>
                  </dl>
                </details>
              </>} />
          </div>
        </section>

        {/* how it works */}
        <section id="how" aria-labelledby="how-title" className="scroll-mt-14 border-b border-line">
          <div className={`${wrap} py-16`}>
            <p className={eyebrow}>How it works</p>
            <h2 id="how-title" className="mt-3 text-3xl font-semibold tracking-tight text-ink">From the archive to your screen in three steps</h2>
            <ol className="mt-10 grid gap-px overflow-hidden border border-line bg-line md:grid-cols-3">
              {STEPS.map(([t, d], i) => (
                <li key={t} className="bg-raised p-6">
                  <span className="font-mono text-[13px] text-accent-ink">0{i + 1}</span>
                  <h3 className="mt-2 text-xl font-semibold text-ink">{t}</h3>
                  <p className="mt-2 text-ink-2">{d}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-[14px] text-ink-3">
              The first look at a new target downloads each observation from the archive (about 10–20 seconds each). After that, it opens instantly.
            </p>
          </div>
        </section>

        {/* features */}
        <section id="features" aria-labelledby="features-title" className="scroll-mt-14 border-b border-line">
          <div className={`${wrap} py-16`}>
            <p className={eyebrow}>Features</p>
            <h2 id="features-title" className="mt-3 text-3xl font-semibold tracking-tight text-ink">A complete instrument for looking at change</h2>
            <p className="mt-3 max-w-2xl text-ink-2">Screenshots of SPHERE TRACK showing real SPHEREx observations of Barnard’s Star (detector D6).</p>
            <div className="mt-10 grid gap-x-8 gap-y-12 md:grid-cols-2">
              {FEATURES.map(([id, t, d, alt], i) => (
                <figure key={id} className="m-0">
                  <button type="button" aria-haspopup="dialog" aria-label={`Enlarge screenshot: ${t}`} data-testid="shot" data-id={id}
                    onClick={e => { opener.current = e.currentTarget; setShot({ i }) }}
                    className="group relative block w-full cursor-zoom-in overflow-hidden border border-line bg-canvas p-0 text-left">
                    <img src={`/media/screens/${id}.webp`} alt={alt} loading="lazy" decoding="async" width={1200} height={750}
                      className="block aspect-[16/10] w-full object-cover object-top" />
                    <span aria-hidden className="absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-sm border border-line bg-panel/90 text-ink-2 group-hover:text-ink">
                      <Maximize2 size={14} />
                    </span>
                  </button>
                  <figcaption>
                    <h3 className="mt-4 text-lg font-semibold text-ink">{t}</h3>
                    <p className="mt-1 text-ink-2">{d}</p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* featured investigation */}
        <section id="investigation" aria-labelledby="inv-title" className="scroll-mt-14 border-b border-line">
          <div className={`${wrap} py-16`}>
            <p className={eyebrow}>Featured investigation</p>
            <h2 id="inv-title" className="mt-3 text-3xl font-semibold tracking-tight text-ink">A trail across Barnard’s Star’s field</h2>
            <p className="mt-3 max-w-3xl text-ink-2">
              While comparing observations of Barnard’s Star, a straight bright line appeared in one exposure and in no other.
              Was it something in the sky, or a fault in the instrument?
            </p>
            <div className="mt-10 grid gap-6 sm:grid-cols-2">
              <Frame f={FRAMES.control}
                alt={`SPHEREx D6 image of the Barnard’s Star field on ${FRAMES.control.date}, without a trail`}
                caption={<><span className="text-ink-2">Six weeks earlier: no trail.</span> {FRAMES.control.obs} · {FRAMES.control.date} · λ {FRAMES.control.lam} µm.</>} />
              <Frame f={FRAMES.trail}
                alt={`SPHEREx D6 image of the Barnard’s Star field on ${FRAMES.trail.date}, crossed by a straight diagonal trail`}
                caption={<><span className="text-ink-2">The trail.</span> {FRAMES.trail.obs} · {FRAMES.trail.date} (single exposure, 01:59:29–02:01:24 UTC) · λ {FRAMES.trail.lam} µm.</>} />
            </div>
            <p className="mt-3 text-[12px] text-ink-3">Both: {FIELD}. {RENDER}</p>

            <div className="mt-10 grid gap-10 md:grid-cols-2">
              <div>
                <h3 className="text-lg font-semibold text-ink">What the data shows</h3>
                <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-2 marker:text-accent">
                  <li>The line appears at the same sky position on a <em>second, separate detector</em> (D3) in the same exposure, so the light came from the sky, not from one detector.</li>
                  <li>Along the same line, seven other D6 observations show nothing, including one about five hours earlier: it is not a fixed source or a recurring artefact.</li>
                  <li>Pixels along the line carry quality flags for signal that changed <em>during</em> the exposure: TRANSIENT on 16% and HALO on 50% of them,
                    against 0.6% and 1.1% of the pixels beside it.</li>
                  <li>The detected part of the trail spans about 2.1° of sky (about 1,250 detector pixels, both ends inside the detector), all recorded
                    within one exposure of about 115 seconds. Motion this rapid is consistent with an object close to Earth, but on its own it does not
                    identify the object.</li>
                </ul>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-ink">What the pipeline reported</h3>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-[13px]">
                  <dt className="text-ink-3">L1 / L2 quality</dt><dd className="m-0 text-ink">Pass / Pass</dd>
                  <dt className="text-ink-3">Satellite streaks (whole detector)</dt><dd className="m-0 text-ink">1 · 3,616 px</dd>
                  <dt className="text-ink-3">Streak-flagged pixels in this field</dt><dd className="m-0 text-ink">0</dd>
                </dl>
                <p className="mt-3 text-ink-2">
                  The one streak the pipeline found lies elsewhere on the detector. This trail carries no streak flags, so an automated
                  “Pass” alone would not have revealed it.
                </p>
              </div>
            </div>

            <div className="mt-10 border-l-2 border-accent bg-raised px-5 py-4">
              <h3 className="text-base font-semibold text-ink">Conclusion</h3>
              <p className="mt-1 text-ink-2">
                The evidence supports an external object moving across the field during this exposure, most likely an Earth-orbiting one.
                It has <strong className="font-semibold text-ink">not</strong> been matched to any catalogued satellite, so its identity is not established.
              </p>
              <p className="mt-2 text-ink-2">
                In a difference image the trail looks like a string of “changes”. Comparing several dates and reading the quality flags is what
                separates a passing object or an instrument effect from a real change in the sky, and SPHERE TRACK is built for exactly
                that kind of checking.
              </p>
            </div>
            <p className="mt-6">
              <a href={BARNARD} className="inline-flex items-center gap-1.5 font-medium text-accent-ink hover:underline">
                Open Barnard’s Star in the Explorer<ArrowRight size={15} aria-hidden />
              </a>
            </p>
          </div>
        </section>

        {/* scientific credibility */}
        <section id="science" aria-labelledby="science-title" className="scroll-mt-14 border-b border-line">
          <div className={`${wrap} py-16`}>
            <p className={eyebrow}>Science</p>
            <h2 id="science-title" className="mt-3 text-3xl font-semibold tracking-tight text-ink">Built on real data, honest about its limits</h2>
            <dl className="mt-10 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2">
              {CREDIBILITY.map(([t, d]) => (
                <div key={t} className="bg-raised p-6">
                  <dt className="font-semibold text-ink">{t}</dt>
                  <dd className="m-0 mt-1.5 text-ink-2">{d}</dd>
                </div>
              ))}
            </dl>
            <h3 className="mt-12 text-lg font-semibold text-ink">Important limitations</h3>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-2 marker:text-accent">
              {LIMITS.map(l => <li key={l}>{l}</li>)}
            </ul>
            <p className="mt-6">
              <a href={DOCS} className="inline-flex items-center gap-1.5 font-medium text-accent-ink hover:underline">
                <BookOpen size={15} aria-hidden />Read the scientific methods and limitations
              </a>
            </p>
          </div>
        </section>

        {/* closing call to action */}
        <section aria-label="Launch the Explorer">
          <div className={`${wrap} flex flex-col items-start gap-5 py-16 sm:flex-row sm:items-center sm:justify-between`}>
            <p className="text-2xl font-semibold tracking-tight text-ink">Pick a star and see how the sky changed.</p>
            <a href={EXPLORER} className={btnPrimary}>Launch Explorer<ArrowRight size={17} aria-hidden /></a>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-raised">
        <div className={`${wrap} grid gap-8 py-10 text-[13px] text-ink-2 md:grid-cols-3`}>
          <div>
            <p className="font-semibold tracking-[0.12em] text-ink">SPHERE TRACK</p>
            <ul className="mt-3 space-y-1.5">
              <li><a href={REPO} className="inline-flex items-center gap-1 hover:text-ink">Source code on GitHub<ExternalLink size={12} aria-hidden /></a></li>
              <li><a href={DOCS} className="inline-flex items-center gap-1 hover:text-ink">Documentation<ExternalLink size={12} aria-hidden /></a></li>
              <li><a href={EXPLORER} className="hover:text-ink">Explorer</a></li>
            </ul>
            <p className="mt-4 text-ink-2">Team: Kiaan Samir · Revant Ghimiray · Abhinav Kumar Singh · Arya Agarwala.</p>
          </div>
          <div>
            <p className="font-semibold text-ink">Data</p>
            <p className="mt-3 text-ink-2">
              SPHEREx Data Release 1 from the NASA/IPAC Infrared Science Archive (IRSA), which is funded by NASA and operated by the
              California Institute of Technology. SIMBAD database, operated at CDS, Strasbourg, France. ESA Gaia DR3, processed by DPAC,
              with the GAVO Data Center as a fallback.
            </p>
          </div>
          <div>
            <p className="font-semibold text-ink">Disclaimer</p>
            <p className="mt-3 text-ink-2">
              SPHERE TRACK is an independent project created for the NASA Space Apps Challenge 2026. It is not endorsed by, sponsored by or
              affiliated with NASA, Caltech/IPAC, the SPHEREx mission team, ESA, CDS or GAVO. It is an exploration tool: a change it shows is a
              candidate for follow-up, not a discovery, and never on its own evidence of “Planet X”.
            </p>
          </div>
        </div>
      </footer>

      <dialog ref={dlg} aria-labelledby="shot-title" data-testid="lightbox"
        onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}  // a click on the backdrop closes
        className="m-auto max-h-[calc(100dvh-1rem)] w-[min(72rem,calc(100vw-1rem))] max-w-none overflow-auto border border-line-strong bg-panel p-0 text-ink backdrop:bg-black/80">
        {open && (
          <div>
            <div className="flex items-start gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <h2 id="shot-title" className="text-base font-semibold text-ink">{open[1]}</h2>
                <p className="mt-0.5 text-[13px] text-ink-2">{open[2]}</p>
              </div>
              <button type="button" onClick={() => dlg.current?.close()} aria-label="Close enlarged screenshot"
                className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-line-strong text-ink-2 hover:bg-hover hover:text-ink">
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="bg-canvas p-2 sm:p-3">
              <img src={`/media/screens/${open[0]}.webp`} alt={open[3]} width={1200} height={750}
                className="mx-auto block h-auto max-h-[calc(100dvh-11rem)] w-auto max-w-full" />
            </div>
            <p className="m-0 border-t border-line px-4 py-2 text-[12px] text-ink-2">
              Screenshot of SPHERE TRACK showing real SPHEREx observations of Barnard’s Star (detector D6). Press Escape or the close button to return.
            </p>
          </div>
        )}
      </dialog>
    </div>
  )
}
