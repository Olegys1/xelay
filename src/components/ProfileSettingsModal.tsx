import { useState, useRef } from 'react'
import { X, Camera, Loader2, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
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
  const [bio, setBio] = useState(xelayUser?.bio || '')
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
      prev.includes(cat)
        ? prev.filter((c) => c !== cat)
        : [...prev, cat]
    )
  }

  const handleAvatarChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0]

    if (!file || !xelayUser?.id) return

    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be smaller than 5MB')
      return
    }

    const localUrl = URL.createObjectURL(file)

    setAvatarPreview(localUrl)
    setUploading(true)
    setError('')

    try {
      const ext = file.name.split('.').pop() || 'jpg'

      const fileName = `${xelayUser.id}-${Date.now()}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, file, {
          upsert: true,
        })

      if (uploadError) throw uploadError

      const {
        data: { publicUrl },
      } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName)

      setAvatarUrl(publicUrl)
      setAvatarPreview(publicUrl)
    } catch (err) {
      console.error(err)
      setError('Avatar upload failed')
      setAvatarPreview(xelayUser?.avatarUrl || '')
    } finally {
      setUploading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!xelayUser?.id) return

    setError('')

    if (!name.trim()) {
      setError('Full name is required')
      return
    }

    setSaving(true)

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: name.trim(),
          country: country.trim(),
          city: city.trim(),
          bio: bio.trim(),
          experience,
          categories,
          avatar_url: avatarUrl,
        })
        .eq('id', xelayUser.id)

      if (error) throw error

      await refreshUser()

      setSaved(true)

      setTimeout(() => {
        onClose()
      }, 1000)
    } catch (err) {
      console.error(err)
      setError('Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-lg bg-background border border-border rounded-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">Profile Settings</h2>

          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          <div className="flex items-center gap-5">
            <div className="relative">
              <div className="w-20 h-20 rounded-full overflow-hidden bg-foreground text-background flex items-center justify-center">
                {avatarPreview ? (
                  <img
                    src={avatarPreview}
                    alt="avatar"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="font-bold text-lg">
                    {initials}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-foreground text-background flex items-center justify-center"
              >
                {uploading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Camera size={14} />
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
              <p className="font-medium">Profile Photo</p>
              <p className="text-sm text-muted-foreground">
                JPG, PNG, WEBP
              </p>
            </div>
          </div>

          {error && (
            <div className="text-sm text-red-500">
              {error}
            </div>
          )}

          <SettingsField
            label="Full Name"
            value={name}
            onChange={setName}
          />

          <div className="grid grid-cols-2 gap-3">
            <SettingsField
              label="Country"
              value={country}
              onChange={setCountry}
            />

            <SettingsField
              label="City"
              value={city}
              onChange={setCity}
            />
          </div>
<div>
  <label className="block mb-2 text-sm font-medium">
    About Yourself
  </label>

  <textarea
    value={bio}
    onChange={(e) => setBio(e.target.value)}
    rows={4}
    maxLength={300}
    placeholder="Tell the community about yourself, your experience, interests, projects..."
    className="w-full px-3 py-2 border border-border rounded-lg bg-background resize-none"
  />

  <p className="text-xs text-muted-foreground mt-1">
    {bio.length}/300
  </p>
</div>
          <div>
            <label className="block mb-2 text-sm font-medium">
              Work Experience
            </label>

            <select
              value={experience}
              onChange={(e) => setExperience(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg bg-background"
            >
              <option value="">Select experience</option>

              {EXPERIENCE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block mb-2 text-sm font-medium">
              Categories
            </label>

            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={`px-3 py-1.5 rounded-full border text-sm transition-all ${
                    categories.includes(cat)
                      ? 'bg-foreground text-background border-foreground'
                      : 'border-border'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-border rounded-lg py-2.5"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={saving || uploading}
              className="flex-1 bg-foreground text-background rounded-lg py-2.5 font-medium"
            >
              {saved ? (
                <span className="flex items-center justify-center gap-2">
                  <Check size={16} />
                  Saved
                </span>
              ) : saving ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Saving
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
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block mb-2 text-sm font-medium">
        {label}
      </label>

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-border rounded-lg bg-background"
      />
    </div>
  )
}