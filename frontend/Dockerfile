FROM nginx:alpine

# Copy static files to nginx html directory
COPY static/ /usr/share/nginx/html/

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
