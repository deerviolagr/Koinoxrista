import axios from 'axios';

import { API_ORIGIN } from './config';

module.exports = async function configureAxios() {
  // Specs use explicit `/api/...` paths so the API contract remains obvious;
  // the origin is centralized so CI never silently falls back to another port.
  axios.defaults.baseURL = API_ORIGIN;
};
