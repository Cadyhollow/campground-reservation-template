'use client'
type Props = {
  onSiteSelect?: (site: any) => void
  onSelectSite?: (site: any) => void
  arrival?: string
  departure?: string
  bookedSiteIds?: string[]
  sites?: any[]
  availableSiteIds?: string[]
  selectedSiteId?: string
  nights?: number
  siteStatuses?: Record<string, 'arriving' | 'occupied' | 'departing' | 'available' | 'blocked'>
}
export default function CampgroundMap({ onSiteSelect, onSelectSite, arrival, departure, bookedSiteIds, sites, availableSiteIds, selectedSiteId, nights, siteStatuses }: Props) {
  return null
}
