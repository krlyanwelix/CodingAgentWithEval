# Build statically, ship tiny: busybox sh comes from alpine, execd is a
# single ~3 MB binary, so the image stays around 15 MB.
ARG BUILDER=golang:1.24-alpine
ARG BASE=alpine:3.20

FROM ${BUILDER} AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/execd .

FROM ${BASE}
RUN mkdir -p /opt/execd /workspace
COPY --from=build /out/execd /opt/execd/execd
WORKDIR /workspace
ENV EXECD_ROOT=/workspace
EXPOSE 8765
ENTRYPOINT ["/opt/execd/execd"]
