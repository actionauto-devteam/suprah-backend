### Example Frontend Implementation (JavaScript with `fetch`)

Here are some example functions showing how to interact with the API.

**1. Login**
```javascript
async function login(email, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('Login failed');
  }

  const { data } = await response.json();
  // Store the access token in memory
  const accessToken = data.tokens.access.token;
  
  // You can also store the user object
  const user = data.user;

  return { accessToken, user };
}
```

**2. Fetching Protected Data**
```javascript
async function fetchUserProfile(accessToken) {
  const response = await fetch('/api/auth/me', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    // This is where you would handle token refreshing
    if (response.status === 401) {
      console.log('Access token expired. Refreshing...');
      // See next section for refresh logic
      return 'TOKEN_EXPIRED';
    }
    throw new Error('Failed to fetch user profile');
  }

  const { data } = await response.json();
  return data;
}
```

**3. Refreshing the Access Token**
```javascript
async function refreshAccessToken() {
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
  });

  if (!response.ok) {
    // If refreshing fails, the user needs to log in again
    throw new Error('Failed to refresh token. Please log in again.');
  }

  const { data } = await response.json();
  // Return the new access token to be stored in memory
  return data.access.token;
}
```

**4. A Complete Example with Automatic Refresh**

This example shows how you might structure an API client that handles token refreshing automatically.

```javascript
// This would be your in-memory store
let accessToken = null;

// An API wrapper function
async function apiFetch(url, options = {}) {
  // Add the authorization header to all requests
  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  let response = await fetch(url, { ...options, headers });

  // If the token is expired, try to refresh it
  if (response.status === 401) {
    try {
      const newAccessToken = await refreshAccessToken();
      accessToken = newAccessToken; // Update the in-memory token

      // Retry the original request with the new token
      headers['Authorization'] = `Bearer ${newAccessToken}`;
      response = await fetch(url, { ...options, headers });

    } catch (refreshError) {
      // If refreshing fails, you should redirect to the login page
      console.error(refreshError.message);
      // For example: window.location.href = '/login';
      return Promise.reject(refreshError);
    }
  }

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || 'API request failed');
  }

  return response.json();
}

// --- How to use the apiFetch wrapper ---

// First, log in to get the initial token
async function handleLogin(email, password) {
    const loginResponse = await login(email, password);
    accessToken = loginResponse.accessToken;
    console.log('Logged in successfully!');
}

// Then, make protected API calls
async function getUserProfile() {
    try {
        const profileResponse = await apiFetch('/api/auth/me');
        console.log('User Profile:', profileResponse.data);
    } catch (error) {
        console.error('Could not fetch profile:', error.message);
    }
}
```

**5. Logout**
```javascript
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  // Clear the access token from memory
  accessToken = null;
  console.log('Logged out successfully.');
}
```