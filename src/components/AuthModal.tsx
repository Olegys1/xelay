import { useState } from 'react'
import { X } from 'lucide-react'
import { blink } from '../blink/client'
import { useAuth } from '../context/AuthContext'
import { CATEGORIES } from '../types'

interface AuthModalProps {
  onClose: () => void
}

type Tab = 'login' | 'register'

const EXPERIENCE_OPTIONS = [
  'Student / Fresh Graduate',
  '1–3 years',
  '3–7 years',
  '7–15 years',
  '15+ years',
]

export function AuthModal({ onClose }: AuthModalProps) {
  const [tab, setTab] = useState<Tab>('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { refreshUser } = useAuth()

  // Login form
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  // Register form
  const [regName, setRegName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regCountry, setRegCountry] = useState('')
  const [regCity, setRegCity] = useState('')
  const [regExperience, setRegExperience] = useState('')
  const [regCategories, setRegCategories] = useState<string[]>([])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await blink.auth.signInWithEmail(loginEmail, loginPassword)
      await refreshUser()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed'
      if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('credentials')) {
        setError('Invalid email or password')
      } else if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no user')) {
        setError('No account found with this email')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!regName.trim()) { setError('Full name is required'); return }
    if (!regCountry.trim()) { setError('Country is required'); return }
    if (!regExperience) { setError('Work experience is required'); return }
    if (regCategories.length === 0) { setError('Select at least one expertise category'); return }
    if (regPassword.length < 6) { setError('Password must be at least 6 characters'); return }

    setLoading(true)
    try {
      // Step 1: Create Blink auth account
      await blink.auth.signUp({ email: regEmail, password: regPassword, displayName: regName })

      // Step 2: Poll for user ID — more reliable than fixed timeout
      let uid = ''
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 500))
        try {
          const me = await blink.auth.me()
          if (me && (me as { id?: string }).id) {
            uid = (me as { id: string }).id
            break
          }
        } catch { /* keep polling */ }
      }

      if (!uid) {
        setError('Account created — please sign in to complete your profile')
        setLoading(false)
        setTab('login')
        return
      }

      // Step 3: Create Xelay profile
      await blink.db.xelayUsers.create({
        id: `u_${Date.now()}`,
        userId: uid,
        name: regName.trim(),
        email: regEmail.trim().toLowerCase(),
        country: regCountry.trim(),
        city: regCity.trim(),
        experience: regExperience,
        categories: JSON.stringify(regCategories),
        rating: 0,
        avatarUrl: '',
        createdAt: new Date().toISOString(),
      })

      await refreshUser()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Registration failed'
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists')) {
        setError('An account with this email already exists')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const toggleCategory = (cat: string) => {
    setRegCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-foreground/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Modal */}
      <div className="relative z-10 w-full max-w-md bg-background border border-border rounded-xl shadow-[var(--shadow-2xl)] animate-fade-in max-h-[90vh] overflow-y-auto">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-muted transition-colors xelay-btn"
          aria-label="Close"
        >
          <X size={18} className="text-foreground" />
        </button>

        {/* Logo */}
        <div className="px-8 pt-8 pb-4 text-center">
          <p className="text-3xl font-bold tracking-tight text-foreground">Xelay</p>
          <p className="text-sm text-muted-foreground mt-1">Knowledge Exchange Platform</p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border mx-8">
          {(['login', 'register'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError('') }}
              className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="px-8 py-6">
          {error && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              {error}
            </div>
          )}

          {tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label="Email" type="email" value={loginEmail} onChange={setLoginEmail} required />
              <Field label="Password" type="password" value={loginPassword} onChange={setLoginPassword} required />
              <SubmitButton loading={loading} label="Sign In" />
              <p className="text-center text-sm text-muted-foreground">
                No account?{' '}
                <button type="button" onClick={() => setTab('register')} className="text-foreground underline hover:text-muted-foreground transition-colors">
                  Register
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <Field label="Full Name" value={regName} onChange={setRegName} required />
              <Field label="Email" type="email" value={regEmail} onChange={setRegEmail} required />
              <Field label="Password (min 6 chars)" type="password" value={regPassword} onChange={setRegPassword} required minLength={6} />
              <Field label="Country" value={regCountry} onChange={setRegCountry} required />
              <Field label="City (optional)" value={regCity} onChange={setRegCity} />

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Work Experience <span className="text-destructive">*</span>
                </label>
                <select
                  value={regExperience}
                  onChange={(e) => setRegExperience(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors"
                >
                  <option value="">Select experience...</option>
                  {EXPERIENCE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Expertise Categories <span className="text-destructive">*</span>
                  <span className="ml-1 text-xs text-muted-foreground">(at least one)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all duration-150 xelay-btn ${
                        regCategories.includes(cat)
                          ? 'bg-foreground text-background border-foreground'
                          : 'bg-background text-foreground border-border hover:border-foreground'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              <SubmitButton loading={loading} label="Create Account" />
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <button type="button" onClick={() => setTab('login')} className="text-foreground underline hover:text-muted-foreground transition-colors">
                  Sign in
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label, type = 'text', value, onChange, required, minLength,
}: {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  minLength?: number
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        minLength={minLength}
        className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors"
      />
    </div>
  )
}

function SubmitButton({ loading, label }: { loading: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full py-3 bg-foreground text-background font-semibold rounded-lg hover:bg-foreground/85 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm xelay-btn"
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
          Processing...
        </span>
      ) : label}
    </button>
  )
}
