import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, Loader2, Wallet } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Mode = 'login' | 'signup' | 'forgot'

export function LoginPage() {
  const navigate = useNavigate()
  const { signIn, signUp, resetPassword, isAuthenticated } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/app', { replace: true })
    }
  }, [isAuthenticated, navigate])

  if (isAuthenticated) {
    return null
  }

  const title = {
    login: 'Welcome back',
    signup: 'Create your account',
    forgot: 'Reset password',
  }[mode]

  const subtitle = {
    login: 'Sign in to access your bills and groups',
    signup: 'Start splitting bills with your groups',
    forgot: "We'll send you a reset link",
  }[mode]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setSubmitting(true)

    try {
      if (mode === 'login') {
        const { error } = await signIn(email, password)
        if (error) {
          setError(error.message)
        } else {
          navigate('/app', { replace: true })
        }
      } else if (mode === 'signup') {
        const { error } = await signUp(email, password)
        if (error) {
          setError(error.message)
        } else {
          setSuccess('Account created! Check your email to confirm, then sign in.')
          setMode('login')
        }
      } else {
        const { error } = await resetPassword(email)
        if (error) {
          setError(error.message)
        } else {
          setSuccess('Reset link sent! Check your email.')
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  function switchMode(newMode: Mode) {
    setMode(newMode)
    setError(null)
    setSuccess(null)
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,rgba(191,219,254,0.75),transparent_28%),linear-gradient(180deg,#f7fbff_0%,#eef6fb_100%)] px-4">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5">
          <div className="rounded-xl bg-blue-600/15 p-2.5 text-blue-600">
            <Wallet className="size-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-slate-800">Kwenta</span>
        </Link>

        <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-[0_14px_40px_rgba(15,23,42,0.06)] sm:p-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-800">{title}</h1>
            <p className="mt-2 text-sm text-slate-600">{subtitle}</p>
          </div>

          {error && (
            <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          {success && (
            <div className="mt-4 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="flex w-full flex-col gap-2">
              <label className="text-sm font-medium text-slate-800" htmlFor="email">
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {mode !== 'forgot' && (
              <div className="flex w-full flex-col gap-2">
                <label className="text-sm font-medium text-slate-800" htmlFor="password">
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    className="pr-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-800"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
            )}

            {mode === 'login' && (
              <div className="flex justify-end">
                <button
                  type="button"
                  className="text-xs text-blue-600 underline-offset-4 hover:underline"
                  onClick={() => switchMode('forgot')}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <Button type="submit" disabled={submitting} className="w-full rounded-xl">
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  {mode === 'login' && 'Sign in'}
                  {mode === 'signup' && 'Create account'}
                  {mode === 'forgot' && 'Send reset link'}
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-white px-2 text-slate-400">or</span>
            </div>
          </div>

          <Button asChild variant="ghost" className="w-full rounded-xl text-slate-600">
            <Link to="/app">Continue without an account</Link>
          </Button>

          <div className="mt-4">
            {mode === 'login' ? (
              <p className="text-center text-sm text-slate-600">
                Don&apos;t have an account?{' '}
                <button
                  className="font-medium text-blue-600 underline-offset-4 hover:underline"
                  onClick={() => switchMode('signup')}
                >
                  Sign up
                </button>
              </p>
            ) : (
              <p className="text-center text-sm text-slate-600">
                Already have an account?{' '}
                <button
                  className="font-medium text-blue-600 underline-offset-4 hover:underline"
                  onClick={() => switchMode('login')}
                >
                  Sign in
                </button>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
