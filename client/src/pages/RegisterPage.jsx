import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { API_URL } from '../config.js';
import { useAuthStore } from '../store/useAuthStore.js';

const ROLES = [
  {
    value: 'interviewer',
    label: 'Interviewer',
    desc: 'Create and conduct interview rooms',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    value: 'supervisor',
    label: 'Supervisor',
    desc: 'Monitor interviews silently',
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    ),
  },
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('interviewer');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [loading, setLoading] = useState(false);

  const validateFields = () => {
    const errors = {};

    if (!name.trim() || name.trim().length < 2) {
      errors.name = 'Name must be at least 2 characters';
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      errors.email = 'Please enter a valid email address';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 8) {
      errors.password = 'Must be at least 8 characters';
    } else if (!/[A-Z]/.test(password)) {
      errors.password = 'Must contain an uppercase letter';
    } else if (!/[a-z]/.test(password)) {
      errors.password = 'Must contain a lowercase letter';
    } else if (!/\d/.test(password)) {
      errors.password = 'Must contain a number';
    }

    if (password && confirmPassword && password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    } else if (!confirmPassword) {
      errors.confirmPassword = 'Please confirm your password';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!validateFields()) return;

    setLoading(true);
    try {
      const res = await axios.post(`${API_URL}/auth/register`, {
        name: name.trim(),
        email: email.trim(),
        password,
        confirmPassword,
        role,
      });

      login(res.data.user, res.data.token);

      if (res.data.user.role === 'interviewer') {
        navigate('/interviewer');
      } else if (res.data.user.role === 'supervisor') {
        navigate('/supervisor');
      }
    } catch (err) {
      console.warn('Registration failed:', err);
      setError(err.response?.data?.error || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Password strength indicator
  const getStrength = () => {
    if (!password) return { level: 0, label: '', color: '' };
    let score = 0;
    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 2) return { level: score, label: 'Weak', color: 'bg-danger-400' };
    if (score <= 3) return { level: score, label: 'Fair', color: 'bg-warning-400' };
    return { level: score, label: 'Strong', color: 'bg-success-400' };
  };

  const strength = getStrength();

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-8">
      {/* Background decorations */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-primary-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-primary-400/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary-500/5 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-lg relative z-10 animate-fade-in">
        {/* Logo & Title */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 shadow-lg shadow-primary-500/30 mb-3">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-surface-50 mb-1">Create Account</h1>
          <p className="text-surface-400 text-sm">Join RecruitMonitor as an interviewer or supervisor</p>
        </div>

        {/* Register Card */}
        <div className="glass-card p-7">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name */}
            <div>
              <label htmlFor="reg-name" className="block text-sm font-medium text-surface-300 mb-1.5">
                Full Name
              </label>
              <input
                id="reg-name"
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setFieldErrors(p => ({ ...p, name: undefined })); }}
                placeholder="Enter your full name"
                className={`glass-input ${fieldErrors.name ? 'border-danger-500/60 focus:ring-danger-500/40' : ''}`}
                autoComplete="name"
                disabled={loading}
              />
              {fieldErrors.name && <p className="mt-1 text-xs text-danger-400">{fieldErrors.name}</p>}
            </div>

            {/* Email */}
            <div>
              <label htmlFor="reg-email" className="block text-sm font-medium text-surface-300 mb-1.5">
                Email Address
              </label>
              <input
                id="reg-email"
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setFieldErrors(p => ({ ...p, email: undefined })); }}
                placeholder="Enter your email"
                className={`glass-input ${fieldErrors.email ? 'border-danger-500/60 focus:ring-danger-500/40' : ''}`}
                autoComplete="email"
                disabled={loading}
              />
              {fieldErrors.email && <p className="mt-1 text-xs text-danger-400">{fieldErrors.email}</p>}
            </div>

            {/* Password */}
            <div>
              <label htmlFor="reg-password" className="block text-sm font-medium text-surface-300 mb-1.5">
                Password
              </label>
              <input
                id="reg-password"
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setFieldErrors(p => ({ ...p, password: undefined })); }}
                placeholder="Min 8 chars, uppercase, lowercase, number"
                className={`glass-input ${fieldErrors.password ? 'border-danger-500/60 focus:ring-danger-500/40' : ''}`}
                autoComplete="new-password"
                disabled={loading}
              />
              {fieldErrors.password && <p className="mt-1 text-xs text-danger-400">{fieldErrors.password}</p>}

              {/* Password strength bar */}
              {password && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 flex gap-1">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                          i <= strength.level ? strength.color : 'bg-surface-700'
                        }`}
                      />
                    ))}
                  </div>
                  <span className={`text-xs font-medium ${
                    strength.level <= 2 ? 'text-danger-400' :
                    strength.level <= 3 ? 'text-warning-400' : 'text-success-400'
                  }`}>
                    {strength.label}
                  </span>
                </div>
              )}
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="reg-confirm" className="block text-sm font-medium text-surface-300 mb-1.5">
                Confirm Password
              </label>
              <input
                id="reg-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setFieldErrors(p => ({ ...p, confirmPassword: undefined })); }}
                placeholder="Re-enter your password"
                className={`glass-input ${fieldErrors.confirmPassword ? 'border-danger-500/60 focus:ring-danger-500/40' : ''}`}
                autoComplete="new-password"
                disabled={loading}
              />
              {fieldErrors.confirmPassword && <p className="mt-1 text-xs text-danger-400">{fieldErrors.confirmPassword}</p>}
            </div>

            {/* Role Selector */}
            <div>
              <label className="block text-sm font-medium text-surface-300 mb-2">Select Your Role</label>
              <div className="grid grid-cols-2 gap-3">
                {ROLES.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setRole(r.value)}
                    disabled={loading}
                    className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border transition-all duration-200 text-center ${
                      role === r.value
                        ? 'bg-primary-500/10 border-primary-500/40 shadow-lg shadow-primary-500/10'
                        : 'bg-surface-800/40 border-surface-700/40 hover:bg-surface-800/70 hover:border-surface-600/50'
                    }`}
                  >
                    <div className={`transition-colors ${role === r.value ? 'text-primary-400' : 'text-surface-400'}`}>
                      {r.icon}
                    </div>
                    <span className={`text-sm font-semibold ${role === r.value ? 'text-primary-300' : 'text-surface-200'}`}>
                      {r.label}
                    </span>
                    <span className="text-xs text-surface-500 leading-tight">{r.desc}</span>
                    {role === r.value && (
                      <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Server error */}
            {error && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-danger-500/10 border border-danger-500/20 text-danger-400 text-sm animate-fade-in">
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Creating account…
                </>
              ) : (
                'Create Account'
              )}
            </button>
          </form>
        </div>

        {/* Links */}
        <div className="text-center mt-5 space-y-2">
          <p className="text-surface-400 text-sm">
            Already have an account?{' '}
            <Link to="/" className="text-primary-400 hover:text-primary-300 font-medium transition-colors">
              Sign in →
            </Link>
          </p>
          <p className="text-surface-400 text-sm">
            Are you a candidate?{' '}
            <Link to="/join" className="text-primary-400 hover:text-primary-300 font-medium transition-colors">
              Join an interview →
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
