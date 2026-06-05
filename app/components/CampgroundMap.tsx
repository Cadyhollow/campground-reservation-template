'use client'
type Props = {
  onSiteSelect?: (site: any) => void
  arrival?: string
  departure?: string
  bookedSiteIds?: string[]
  sites?: any[]
  availableSiteIds?: string[]
  selectedSiteId?: string
  nights?: number
}
export default function CampgroundMap({ onSiteSelect, arrival, departure, bookedSiteIds, sites, availableSiteIds, selectedSiteId, nights }: Props) {
  return null
}
