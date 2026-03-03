/**
 * PM2 Ecosystem Config for Lab_Assistant
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs      # Start all servers
 *   pm2 stop all                        # Stop all servers
 *   pm2 restart all                     # Restart all servers
 *   pm2 logs                            # View logs
 *   pm2 monit                           # Monitor dashboard
 *   pm2 startup                         # Set up auto-start on boot
 *   pm2 save                            # Save current process list
 */

module.exports = {
  apps: [
    {
      name: 'lab-server',
      script: 'server/oven-timer-server.js',
      cwd: '/Users/philipgordon/Documents/GitHub/Lab_Assistant',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      error_file: '/Users/philipgordon/Documents/GitHub/Lab_Assistant/logs/lab-server-error.log',
      out_file: '/Users/philipgordon/Documents/GitHub/Lab_Assistant/logs/lab-server-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'gateway',
      script: 'npx',
      args: 'tsx index.ts',
      cwd: '/Users/philipgordon/Documents/GitHub/Lab_Assistant/gateway',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      error_file: '/Users/philipgordon/Documents/GitHub/Lab_Assistant/logs/gateway-error.log',
      out_file: '/Users/philipgordon/Documents/GitHub/Lab_Assistant/logs/gateway-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
