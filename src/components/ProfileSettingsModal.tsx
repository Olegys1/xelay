import { useState, useRef } from 'react'
import { X, Camera, Loader2, Check } from 'lucide-react'
import { blink } from '../blink/client'
import { useAuth } from '../context/AuthContext'
import { CATEGORIES } from '../types'

interface ProfileSettingsModalProps {
  onClose: () => void
}

const EXPERIENCE_OPTIONS = [
  'Student / Fresh Graduate',
  '1–3 years',
  '3–7 years',
  '7–15 years',
  '15+ years',
]

export function ProfileSettingsModal({ onClose }: ProfileSettingsModalProps) {
  const { xelayUser, refreshUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState(xelayUser?.name || '')
  const [country, setCountry] = useState(xelayUser?.country || '')
  const [city, setCity] = useState(xelayUser?.city || '')
  const [experience, setExperience] = useState(xelayUser?.experience || '')
  const [categories, setCategories] = useState<string[]>(xelayUser?.categories || [])
  const [avatarUrl, setAvatarUrl] = useState(xelayUser?.avatarUrl || '')
  const [avatarPreview, setAvatarPreview] = useState(xelayUser?.avatarUrl || '')

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const toggleCategory = (cat: string) => {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate type
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file')
      return
    }
    // Validate size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be smaller than 5MB')
      return
    }

    // Show local preview immediately
    const localUrl = URL.createObjectURL(file)
    setAvatarPreview(localUrl)
    setError('')
    setUploading(true)

    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const path = `avatars/${xelayUser!.userId}/${Date.now()}.${ext}`
      const { publicUrl } = await blink.storage.upload(file, path, {
        onProgress: () => {},
      })
      setAvatarUrl(publicUrl)
      setAvatarPreview(publicUrl)
    } catch (err) {
      setError('Avatar upload failed. Please try again.')
      setAvatarPreview(xelayUser?.avatarUrl || '')
      console.error('Avatar upload error:', err)
    } finally {
      setUploading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!name.trim()) { setError('Full name is required'); return }
    if (!country.trim()) { setError('Country is required'); return }
    if (!experience) { setError('Work experience is required'); return }
    if (categories.length === 0) { setError('Select at least one category'); return }
    if (!xelayUser?.id) return

    setSaving(true)
    try {
      await blink.db.xelayUsers.update(xelayUser.id, {
        name: name.trim(),
        country: country.trim(),
        city: city.trim(),
        experience,
        categories: JSON.stringify(categories),
        avatarUrl: avatarUrl || '',
      })

      await refreshUser()
      setSaved(true)
      setTimeout(() => {
        setSaved(false)
        onClose()
      }, 1200)
    } catch (err) {
      console.error('Save error:', err)
      setError('Failed to save changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const initials = name
    ? name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : '?'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-foreground/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg bg-background border border-border rounded-xl shadow-[var(--shadow-2xl)] animate-fade-in max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold text-foreground">Profile Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-muted transition-colors xelay-btn"
            aria-label="Close"
          >
            <X size={18} className="text-foreground" />
          </button>
        </div>

        <form onSubmit={handleSave} className="px-6 py-5 space-y-5">
          {/* Avatar Upload */}
          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              <div className="w-20 h-20 rounded-full overflow-hidden bg-foreground flex items-center justify-center">
                {avatarPreview ? (
                  <img
                    src={avatarPreview}
                    alt="Avatar"
                    className="w-full h-full object-cover"
                    onError={() => setAvatarPreview('')}
                  />
                ) : (
                  <span className="text-background text-xl font-bold">{initials}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="absolute -bottom-1 -right-1 w-7 h-7 bg-foreground text-background rounded-full flex items-center justify-center hover:bg-foreground/80 transition-colors xelay-btn disabled:opacity-50"
                aria-label="Upload avatar"
              >
                {uploading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Camera size={13} />
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Profile Photo</p>
              <p className="text-xs text-muted-foreground mt-0.5">JPG, PNG or WebP · max 5MB</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="mt-2 text-xs font-medium text-foreground underline hover:text-muted-foreground transition-colors disabled:opacity-50"
              >
                {uploading ? 'Uploading...' : 'Change photo'}
              </button>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Name */}
          <SettingsField
            label="Full Name"
            value={name}
            onChange={setName}
            required
          />

          {/* Country + City */}
          <div className="grid grid-cols-2 gap-3">
            <SettingsField
              label="Country"
              value={country}
              onChange={setCountry}
              required
            />
            <SettingsField
              label="City (optional)"
              value={city}
              onChange={setCity}
            />
          </div>

          {/* Experience */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Work Experience <span className="text-destructive">*</span>
            </label>
            <select
              value={experience}
              onChange={(e) => setExperience(e.target.value)}
              required
              className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors"
            >
              <option value="">Select experience...</option>
              {EXPERIENCE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>

          {/* Expertise Categories */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Expertise Categories <span className="text-destructive">*</span>
              <span className="ml-1 text-xs text-muted-foreground">(select at least one)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all duration-150 xelay-btn ${
                    categories.includes(cat)
                      ? 'bg-foreground text-background border-foreground scale-[1.02]'
                      : 'bg-background text-foreground border-border hover:border-foreground'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border border-border rounded-lg text-sm font-medium text-foreground hover:bg-muted transition-colors xelay-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || uploading}
              className="flex-1 py-2.5 bg-foreground text-background rounded-lg text-sm font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-60 disabled:cursor-not-allowed xelay-btn"
            >
              {saved ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Check size={15} />
                  Saved!
                </span>
              ) : saving ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Loader2 size={15} className="animate-spin" />
                  Saving...
                </span>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SettingsField({
  label,
  value,
  onChange,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors"
      />
    </div>
  )
}
