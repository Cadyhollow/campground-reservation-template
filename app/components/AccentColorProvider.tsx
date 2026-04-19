'use client'

import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'

export default function AccentColorProvider() {
  useEffect(() => {
    async function loadAccentColor() {
      try {
        const { data } = await supabase
          .from('settings')
          .select('accent_color')
          .limit(1)
          .single()
        
        if (data?.accent_color) {
          document.documentElement.style.setProperty('--accent-color', data.accent_color)
        }
      } catch (err) {
        console.error('Failed to load accent color:', err)
      }
    }
    loadAccentColor()
  }, [])

  return null
}
