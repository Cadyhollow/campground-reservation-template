'use client'

import { useEffect, useRef, useState } from 'react'

type Site = {
  id: string
  site_number: string
  site_type: string
  amp_service: string
  hookups: string
  base_rate: number
  nightly_rate?: number
  total_price?: number
  nights?: number
  min_stay?: number
  meets_min_stay?: boolean
  description?: string
  max_rv_length?: number | null | undefined
}

type Props = {
  sites: Site[]
  availableSiteIds: string[]
  selectedSiteId?: string
  onSelectSite: (site: Site) => void
  nights?: number
}

const SITE_NUMBERS: Record<string, string[]> = {
  row1: ['63','64','65','66','67','68','69','70','71','72','73','74','75','76','77','78','79'],
  row2: ['46','47','48','49','50','51','52','53','54','55','56','57','58','59','60','61','62'],
  row3: ['C1','31','32','33','34','35','36','37','38','39','40','41','42','43','44','45'],
  row4: ['14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29'],
  row5: ['1','2','3','4','5','6','7','8','9','10','11','12','13'],
  topRight: ['80','81','82','83','84','85','C2','C3'],
}

export default function CampgroundMap({ sites, availableSiteIds, selectedSiteId, onSelectSite, nights }: Props) {
  const [hoveredNum, setHoveredNum] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; site: Site } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const siteByNumber = Object.fromEntries(sites.map(s => [s.site_number, s]))

  function getColor(num: string) {
  const site = siteByNumber[num]
  if (!site) return '#d1d5db'
  
  const isAvailable = availableSiteIds.includes(site.id)
  
  if (!isAvailable) return '#d1d5db'
  if (selectedSiteId === site.id) return '#3DBDD4'
  if (hoveredNum === num) return '#6ee7b7'
  
  if (num === 'C1') return '#f5e07a'
  if (num === 'C2' || num === 'C3') return '#e88a8a'
  if (site.hookups === 'water_electric') return '#bfdbfe'
  return '#bbf7d0'
}

  function getStroke(num: string) {
    if (num === 'C1') return '#a89020'
    if (num === 'C2' || num === 'C3') return '#a84a4a'
    const site = siteByNumber[num]
    if (!site) return '#9ca3af'
    if (selectedSiteId === site.id) return '#0e7490'
    const isAvailable = availableSiteIds.includes(site.id)
   if (!isAvailable) return '#9ca3af'
    return '#5a8a5a'
  }

  function handleClick(num: string, e: React.MouseEvent) {
    const site = siteByNumber[num]
    if (!site) return
    if (!availableSiteIds.includes(site.id)) return
    onSelectSite(site)
  }

  function handleMouseEnter(num: string, e: React.MouseEvent) {
    const site = siteByNumber[num]
    if (!site) return
    setHoveredNum(num)
    const rect = svgRef.current?.getBoundingClientRect()
    if (rect) {
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top - 10,
        site,
      })
    }
  }

  function handleMouseLeave() {
    setHoveredNum(null)
    setTooltip(null)
  }

  function siteLabel(site: Site) {
    const available = availableSiteIds.includes(site.id)
    const rate = site.nightly_rate || site.base_rate
    return `Site ${site.site_number} · ${available ? '$' + (rate / 100).toFixed(0) + '/night' : 'Booked'}`
  }

  function ampLabel(a: string) {
    if (a === '30amp') return '30 Amp'
    if (a === '30_50amp') return '30/50 Amp'
    return ''
  }

  function hookupLabel(h: string) {
    if (h === 'full') return 'Full Hookup'
    if (h === 'water_electric') return 'Water & Electric'
    return ''
  }

  const SiteRect = ({ num, x, y, w, h }: { num: string; x: number; y: number; w: number; h: number }) => {
    const site = siteByNumber[num]
    const isCabin = num === 'C1' || num === 'C2' || num === 'C3'
    const isAvailable = site ? availableSiteIds.includes(site.id) : false
    const isClickable = site && (isAvailable || isCabin)

    return (
      <g
        style={{ cursor: isClickable && !isCabin ? 'pointer' : 'default' }}
        onClick={(e) => handleClick(num, e)}
        onMouseEnter={(e) => handleMouseEnter(num, e)}
        onMouseLeave={handleMouseLeave}
      >
        <rect
          x={x} y={y} width={w} height={h}
          fill={getColor(num)}
          stroke={getStroke(num)}
          strokeWidth={selectedSiteId === site?.id ? 2 : 0.5}
          rx="2"
        />
        <text
          x={x + w / 2} y={y + h / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily="Arial"
          fontSize="8"
          fontWeight="bold"
          fill={num === 'C1' ? '#633806' : num === 'C2' || num === 'C3' ? '#791F1F' : '#27500A'}
          transform={`rotate(-90,${x + w / 2},${y + h / 2})`}
        >
          {num}
        </text>
      </g>
    )
  }

  return (
    <div className="relative w-full">
      {/* Legend */}
<div className="flex items-center gap-4 mb-3 flex-wrap text-xs">
  <div className="flex items-center gap-1.5">
    <div className="w-3 h-3 rounded-sm bg-gray-300 border border-gray-400"/>
    <span className="text-gray-600">Not available for selected dates</span>
  </div>
  <div className="flex items-center gap-1.5">
    <div className="w-3 h-3 rounded-sm border-2" style={{ backgroundColor: '#3DBDD4', borderColor: '#0e7490' }}/>
    <span className="text-gray-600">Selected</span>
  </div>
</div>

      <div className="relative">
        <svg
          ref={svgRef}
          width="100%"
          viewBox="0 0 820 1080"
          className="rounded-xl border border-gray-200"
        >
          {/* Grass background */}
          <rect width="820" height="1080" fill="#c8e6c0"/>

          {/* PERIMETER TREES */}
          <g fill="#2d6a1f">
            <circle cx="210" cy="15" r="13"/><circle cx="235" cy="8" r="10"/><circle cx="258" cy="16" r="12"/>
            <circle cx="282" cy="9" r="10"/><circle cx="305" cy="16" r="13"/><circle cx="328" cy="9" r="11"/>
            <circle cx="352" cy="16" r="12"/><circle cx="376" cy="9" r="10"/><circle cx="400" cy="16" r="13"/>
            <circle cx="424" cy="9" r="11"/><circle cx="448" cy="16" r="12"/><circle cx="472" cy="9" r="10"/>
            <circle cx="496" cy="16" r="13"/><circle cx="520" cy="9" r="11"/><circle cx="544" cy="16" r="12"/>
            <circle cx="568" cy="9" r="10"/>
            <circle cx="775" cy="55" r="14"/><circle cx="790" cy="80" r="11"/>
            <circle cx="778" cy="108" r="13"/><circle cx="792" cy="135" r="11"/>
            <circle cx="779" cy="163" r="14"/><circle cx="793" cy="192" r="11"/>
            <circle cx="779" cy="222" r="13"/><circle cx="793" cy="252" r="11"/>
            <circle cx="779" cy="283" r="14"/><circle cx="793" cy="314" r="11"/>
            <circle cx="779" cy="346" r="13"/><circle cx="793" cy="378" r="11"/>
            <circle cx="779" cy="410" r="14"/><circle cx="793" cy="442" r="11"/>
            <circle cx="779" cy="475" r="13"/><circle cx="793" cy="508" r="11"/>
            <circle cx="779" cy="541" r="14"/>
            <circle cx="14" cy="95" r="12"/><circle cx="7" cy="124" r="10"/>
            <circle cx="15" cy="153" r="12"/><circle cx="7" cy="182" r="10"/>
            <circle cx="15" cy="211" r="12"/><circle cx="7" cy="240" r="10"/>
            <circle cx="15" cy="269" r="12"/><circle cx="7" cy="298" r="10"/>
            <circle cx="15" cy="327" r="12"/>
            <circle cx="54" cy="882" r="14"/><circle cx="82" cy="873" r="11"/><circle cx="110" cy="883" r="13"/>
            <circle cx="140" cy="874" r="11"/><circle cx="170" cy="883" r="14"/><circle cx="200" cy="874" r="11"/>
            <circle cx="230" cy="883" r="13"/><circle cx="260" cy="874" r="11"/><circle cx="290" cy="883" r="14"/>
            <circle cx="322" cy="874" r="11"/><circle cx="354" cy="883" r="13"/><circle cx="386" cy="874" r="11"/>
            <circle cx="418" cy="883" r="14"/><circle cx="450" cy="874" r="11"/><circle cx="482" cy="883" r="13"/>
            <circle cx="514" cy="874" r="11"/><circle cx="546" cy="883" r="14"/><circle cx="578" cy="874" r="11"/>
            <circle cx="610" cy="883" r="13"/><circle cx="642" cy="874" r="11"/><circle cx="674" cy="883" r="14"/>
            <circle cx="706" cy="874" r="11"/><circle cx="738" cy="883" r="13"/>
            <circle cx="592" cy="12" r="12"/><circle cx="616" cy="7" r="10"/><circle cx="640" cy="13" r="12"/>
            <circle cx="664" cy="7" r="10"/><circle cx="688" cy="13" r="12"/><circle cx="712" cy="7" r="10"/>
            <circle cx="736" cy="14" r="12"/><circle cx="758" cy="8" r="10"/>
            <circle cx="608" cy="36" r="11"/><circle cx="632" cy="30" r="10"/><circle cx="656" cy="37" r="12"/>
            <circle cx="680" cy="30" r="10"/><circle cx="704" cy="37" r="11"/><circle cx="728" cy="30" r="10"/>
            <circle cx="752" cy="38" r="12"/>
            <circle cx="600" cy="66" r="11"/><circle cx="598" cy="94" r="12"/>
            <circle cx="597" cy="122" r="11"/><circle cx="598" cy="150" r="12"/>
            <circle cx="597" cy="178" r="11"/><circle cx="598" cy="206" r="10"/>
            <circle cx="597" cy="234" r="11"/>
          </g>
          <g fill="#2d6a1f" opacity="0.85">
            <circle cx="85" cy="622" r="9"/><circle cx="112" cy="614" r="7"/>
            <circle cx="148" cy="623" r="9"/><circle cx="186" cy="615" r="7"/>
            <circle cx="224" cy="623" r="8"/><circle cx="260" cy="615" r="7"/>
            <circle cx="296" cy="623" r="9"/><circle cx="330" cy="615" r="7"/>
          </g>

          {/* CHECK IN */}
          <rect x="28" y="240" width="20" height="390" fill="#b0a090" rx="3"/>
          <text x="38" y="440" textAnchor="middle" fontFamily="Arial" fontSize="9" fontWeight="bold" fill="#5a4a3a" transform="rotate(-90,38,440)">CHECK-IN / STORE</text>

          {/* LOGO */}
          <rect x="30" y="25" width="135" height="95" fill="#2B2B2B" rx="10"/>
          <ellipse cx="97" cy="57" rx="9" ry="15" fill="#4DBFB8"/>
          <ellipse cx="97" cy="66" rx="5" ry="7" fill="#2B2B2B"/>
          <line x1="83" y1="74" x2="111" y2="67" stroke="#4DBFB8" strokeWidth="3" strokeLinecap="round"/>
          <line x1="83" y1="67" x2="111" y2="74" stroke="#4DBFB8" strokeWidth="3" strokeLinecap="round"/>
          <text x="97" y="90" textAnchor="middle" fontFamily="Arial" fontSize="12" fontWeight="bold" fill="white">{campgroundName}</text>
          <text x="97" y="103" textAnchor="middle" fontFamily="Arial" fontSize="7.5" fill="#4DBFB8" letterSpacing="1">CAMPGROUND</text>
          <text x="97" y="117" textAnchor="middle" fontFamily="Arial" fontSize="8" fill="#aaa">{campgroundLocation}</text>

          {/* LOOP 1 ROADS */}
          <rect x="52" y="178" width="536" height="13" fill="#b0a090" rx="6"/>
          <rect x="52" y="320" width="536" height="13" fill="#b0a090" rx="6"/>
          <rect x="52" y="178" width="13" height="155" fill="#b0a090"/>
          <rect x="575" y="178" width="13" height="155" fill="#b0a090"/>

          {/* Volleyball */}
          <rect x="250" y="148" width="150" height="26" fill="#d4c4a8" rx="3" stroke="#a09070" strokeWidth="0.5"/>
          <text x="325" y="164" textAnchor="middle" fontFamily="Arial" fontSize="8" fill="#6a5a4a">Volleyball / Basketball</text>

          {/* ROW 1: 63-79 */}
          {['63','64','65','66','67','68','69','70','71','72','73','74'].map((num, i) => (
            <SiteRect key={num} num={num} x={65 + i * 30} y={191} w={28} h={36}/>
          ))}
          {['75','76','77','78','79'].map((num, i) => (
            <SiteRect key={num} num={num} x={425 + i * 30} y={191} w={28} h={36}/>
          ))}

          {/* ROW 2: 46-62 */}
          {['46','47','48','49','50','51','52','53','54','55','56','57'].map((num, i) => (
            <SiteRect key={num} num={num} x={65 + i * 30} y={282} w={28} h={36}/>
          ))}
          {['58','59','60','61','62'].map((num, i) => (
            <SiteRect key={num} num={num} x={425 + i * 30} y={282} w={28} h={36}/>
          ))}

          {/* LOOP 2 ROADS */}
          <rect x="52" y="358" width="536" height="13" fill="#b0a090" rx="6"/>
          <rect x="52" y="530" width="536" height="13" fill="#b0a090" rx="6"/>
          <rect x="52" y="358" width="13" height="185" fill="#b0a090"/>
          <rect x="575" y="358" width="13" height="185" fill="#b0a090"/>

          {/* ROW 3: C1 + 31-45 */}
          <SiteRect num="C1" x={65} y={372} w={28} h={36}/>
          {['31','32','33','34','35','36','37','38','39','40','41','42','43','44','45'].map((num, i) => (
            <SiteRect key={num} num={num} x={95 + i * 30} y={372} w={28} h={36}/>
          ))}

          {/* Bath house */}
          <rect x="278" y="415" width="58" height="62" fill="#e8e0d0" rx="4" stroke="#a09080" strokeWidth="0.5"/>
          <text x="307" y="436" textAnchor="middle" fontFamily="Arial" fontSize="8" fontWeight="bold" fill="#5a4a3a">Bath</text>
          <text x="307" y="447" textAnchor="middle" fontFamily="Arial" fontSize="8" fontWeight="bold" fill="#5a4a3a">house</text>
          <rect x="285" y="453" width="44" height="18" fill="#d0c8b8" rx="2"/>
          <text x="307" y="465" textAnchor="middle" fontFamily="Arial" fontSize="7" fill="#5a4a3a">Laundry</text>

          {/* ROW 4: 14-20, gap, 21-29 */}
          {['14','15','16','17','18','19','20'].map((num, i) => (
            <SiteRect key={num} num={num} x={65 + i * 30} y={490} w={28} h={36}/>
          ))}
          {['21','22','23','24','25','26','27','28','29'].map((num, i) => (
            <SiteRect key={num} num={num} x={305 + i * 30} y={490} w={28} h={36}/>
          ))}

          {/* SITES 1-13 ROAD */}
          <rect x="52" y="558" width="506" height="12" fill="#b0a090" rx="4"/>
          {['1','2','3','4','5','6','7','8','9','10','11','12','13'].map((num, i) => (
            <SiteRect key={num} num={num} x={65 + i * 30} y={571} w={28} h={36}/>
          ))}

          {/* Dump station */}
          <rect x="460" y="566" width="98" height="26" fill="#c8b898" rx="3" stroke="#907858" strokeWidth="0.5"/>
          <text x="509" y="583" textAnchor="middle" fontFamily="Arial" fontSize="8" fontWeight="bold" fill="#5a4030">Dump station</text>

          {/* TOP RIGHT: 80-85 + C2/C3 */}
          <SiteRect num="80" x={608} y={62} w={20} h={34}/>
          {['81','82','83','84','85'].map((num, i) => (
            <SiteRect key={num} num={num} x={632 + i * 23} y={64} w={20} h={30}/>
          ))}
          <SiteRect num="C2" x={748} y={64} w={22} h={30}/>
          <SiteRect num="C3" x={748} y={158} w={22} h={30}/>

          {/* Open field */}
          <text x="300" y="640" textAnchor="middle" fontFamily="Arial" fontSize="9" fill="#5a8a3a" fontStyle="italic">open field</text>

          {/* POOL */}
          <rect x="54" y="658" width="68" height="68" fill="#7dd4e8" rx="8" stroke="#4a9ab8" strokeWidth="1"/>
          <rect x="59" y="663" width="58" height="58" fill="#aeeeff" rx="5" opacity="0.7"/>
          <text x="88" y="696" textAnchor="middle" fontFamily="Arial" fontSize="11" fontWeight="bold" fill="#0C447C">Pool</text>

          {/* PAVILION */}
          <rect x="54" y="738" width="105" height="50" fill="#2d6a1f" rx="6"/>
          <text x="106" y="768" textAnchor="middle" fontFamily="Arial" fontSize="10" fontWeight="bold" fill="white">Pavilion</text>

          {/* Corn hole */}
          <rect x="54" y="794" width="105" height="28" fill="#c8e6c0" rx="4" stroke="#5a8a5a" strokeWidth="0.5"/>
          <text x="106" y="812" textAnchor="middle" fontFamily="Arial" fontSize="8" fill="#27500A">Corn hole court</text>

          {/* POND */}
          <ellipse cx="330" cy="748" rx="118" ry="80" fill="#7dd4e8" stroke="#4a9ab8" strokeWidth="1"/>
          <ellipse cx="330" cy="748" rx="97" ry="64" fill="#aeeeff" opacity="0.6"/>
          <ellipse cx="330" cy="748" rx="60" ry="40" fill="#c8f4ff" opacity="0.5"/>
          <text x="330" y="753" textAnchor="middle" fontFamily="Arial" fontSize="13" fontWeight="bold" fill="#0C447C">Pond</text>

          {/* PLAYGROUND */}
          <rect x="496" y="668" width="100" height="54" fill="#f4c0d1" rx="5" stroke="#d4537e" strokeWidth="0.5"/>
          <text x="546" y="692" textAnchor="middle" fontFamily="Arial" fontSize="10" fontWeight="bold" fill="#791F1F">Playground</text>

          {/* PUTT PUTT */}
          <rect x="614" y="572" width="120" height="58" fill="#97C459" rx="6" stroke="#3B6D11" strokeWidth="0.5"/>
          <text x="674" y="596" textAnchor="middle" fontFamily="Arial" fontSize="10" fontWeight="bold" fill="#173404">Putt-putt</text>
          <text x="674" y="613" textAnchor="middle" fontFamily="Arial" fontSize="10" fontWeight="bold" fill="#173404">course</text>

          {/* GOLF */}
          <rect x="54" y="920" width="220" height="46" fill="#639922" rx="6" stroke="#3B6D11" strokeWidth="0.5"/>
          <text x="164" y="948" textAnchor="middle" fontFamily="Arial" fontSize="11" fontWeight="bold" fill="white">Golf Accuracy Range</text>

          {/* Title */}
          <rect x="210" y="1042" width="400" height="28" fill="#2B2B2B" rx="6"/>
          <text x="410" y="1061" textAnchor="middle" fontFamily="Arial" fontSize="11" fontWeight="bold" fill="white">{campgroundName} — {campgroundLocation}</text>
        </svg>

        {/* Tooltip */}
        {tooltip && (
          <div
            className="absolute z-10 bg-white rounded-lg shadow-lg border border-gray-100 p-3 text-xs pointer-events-none"
            style={{ left: tooltip.x + 10, top: tooltip.y - 60, minWidth: '160px' }}
          >
            <p className="font-bold text-gray-900 mb-1">Site {tooltip.site.site_number}</p>
            <p className="text-gray-600">{tooltip.site.hookups === 'full' ? 'Full Hookup' : 'Water & Electric'}</p>
            {tooltip.site.amp_service && tooltip.site.amp_service !== 'none' && (
              <p className="text-gray-600">{tooltip.site.amp_service === '30amp' ? '30 Amp' : '30/50 Amp'}</p>
            )}
            {tooltip.site.max_rv_length && (
              <p className="text-gray-600">Max RV: {tooltip.site.max_rv_length}ft</p>
            )}
            <p className="font-semibold mt-1" style={{ color: availableSiteIds.includes(tooltip.site.id) ? '#16a34a' : '#dc2626' }}>
              {availableSiteIds.includes(tooltip.site.id)
                ? '$' + ((tooltip.site.nightly_rate || tooltip.site.base_rate) / 100).toFixed(0) + '/night'
                : 'Not available'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}