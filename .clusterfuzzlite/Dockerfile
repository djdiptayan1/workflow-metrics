FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:717f88cd72ee85ab295debf1272eed85590621d6ba9d70d6c59133a61f3f3acf

COPY . $SRC/workflow-metrics
WORKDIR $SRC/workflow-metrics

COPY .clusterfuzzlite/build.sh $SRC/build.sh
